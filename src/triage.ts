import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type {
  CallsheetConfig,
  TriageAction,
  TriageSession,
  TriageProfile,
  TriageVerb,
} from './types.js';
import { fetchAll, buildDataPayload, stripJsonCodeFences } from './core.js';
import { loadTriageFile, resolveProfile, applyProfileOverrides } from './triage-profile.js';
import {
  getGmailClient,
  archiveMessage,
  markMessageRead,
  trashMessage,
} from './connectors/gmail-mutate.js';
import { logUsage } from './usage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TRIAGE_PROMPT_PATH = join(__dirname, 'prompts', 'triage.md');
const TRIAGE_OUTPUT_SUBDIR = 'triage';
const DEFAULT_TRIAGE_FILE = 'triage.yaml';

/**
 * Execution options for runTriage. Kept separate from TriageSession so the
 * caller can plumb a custom profile object (the interactive drill-down flow
 * builds one in-memory rather than loading from disk).
 */
export interface RunTriageOptions {
  /** Path to the triage.yaml file. Defaults to 'triage.yaml' in cwd. */
  triageFile?: string;
  /**
   * Override the loaded profile. When set, triageFile / profileName are
   * ignored. Used by the `[m]ore` drill-down flow which synthesizes a
   * narrower profile on the fly.
   */
  profile?: TriageProfile;
  /** Optional label attached to the session log — e.g., 'default' or 'drill:alice@x.com'. */
  profileName?: string;
}

function loadSystemPrompt(): string {
  return readFileSync(TRIAGE_PROMPT_PATH, 'utf-8');
}

/**
 * Execute a full triage pass:
 *   1. Resolve the profile (from triage.yaml or passed in).
 *   2. Apply overrides on top of the base config and fetch connector data.
 *   3. Ask Claude for a summary + per-item action proposals.
 *   4. Return the parsed TriageSession for the caller (CLI / dashboard) to
 *      render and execute.
 *
 * Does NOT execute any action side effects — that's executeAction's job.
 */
export async function runTriage(
  baseConfig: CallsheetConfig,
  profileNameOrOptions: string | RunTriageOptions = 'default',
): Promise<TriageSession> {
  const opts: RunTriageOptions =
    typeof profileNameOrOptions === 'string'
      ? { profileName: profileNameOrOptions }
      : profileNameOrOptions;

  const profileName = opts.profileName ?? 'default';
  let profile: TriageProfile;
  if (opts.profile) {
    profile = opts.profile;
  } else {
    const file = loadTriageFile(opts.triageFile ?? DEFAULT_TRIAGE_FILE, baseConfig);
    profile = resolveProfile(file, profileName);
  }

  const effectiveConfig = applyProfileOverrides(baseConfig, profile);

  console.log(
    `Triage profile: ${profileName}${profile.description ? ` — ${profile.description}` : ''}`,
  );
  console.log('Fetching scoped connector data...');
  const { results, issues } = await fetchAll(effectiveConfig);
  if (issues.length) {
    for (const issue of issues) {
      console.log(`  ! ${issue.connector}: ${issue.error}`);
    }
  }
  if (results.length === 0) {
    throw new Error(
      'Triage fetched no data. Check that the profile references at least one enabled, configured connector.',
    );
  }

  const dataPayload = buildDataPayload(results);

  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set.');
  }
  const client = new Anthropic({ apiKey });
  const model = baseConfig.model ?? 'claude-sonnet-4-20250514';
  const outputDir = baseConfig.output_dir ?? 'output';

  console.log(`Analyzing with Claude (${model})...`);
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: loadSystemPrompt(),
    messages: [
      {
        role: 'user',
        content:
          `Triage profile: ${profileName}.\n\n` +
          'Here is the scoped data to triage:\n' +
          `<data>\n${dataPayload}\n</data>\n\n` +
          'Return the JSON TriageSession now — summary + one action per item.',
      },
    ],
  });
  logUsage(outputDir, model, 'triage', response.usage.input_tokens, response.usage.output_tokens);

  const text = stripJsonCodeFences((response.content[0] as { type: 'text'; text: string }).text);
  const parsed = parseTriageResponse(text);

  const session: TriageSession = {
    summary: parsed.summary,
    profile: profileName,
    actions: parsed.actions,
    generated_at: new Date().toISOString(),
  };
  return session;
}

interface ParsedResponse {
  summary: string;
  actions: TriageAction[];
}

/**
 * Parse + lightly validate a Claude triage response. Malformed entries
 * are dropped with a console warning rather than failing the whole pass;
 * the user can still act on the valid entries.
 */
export function parseTriageResponse(text: string): ParsedResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Triage response was not valid JSON: ${e instanceof Error ? e.message : e}\nRaw:\n${text.slice(0, 400)}`,
      { cause: e },
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Triage response root must be an object.');
  }
  const {summary} = (raw as { summary?: unknown });
  const actionsRaw = (raw as { actions?: unknown }).actions;
  if (typeof summary !== 'string') {
    throw new Error("Triage response is missing a string 'summary'.");
  }
  if (!Array.isArray(actionsRaw)) {
    throw new Error("Triage response is missing an 'actions' array.");
  }
  const actions: TriageAction[] = [];
  for (const entry of actionsRaw) {
    const action = coerceAction(entry);
    if (action) actions.push(action);
  }
  return { summary, actions };
}

function coerceAction(entry: unknown): TriageAction | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.item_summary !== 'string') return null;
  if (e.source !== 'gmail' && e.source !== 'todoist') return null;
  if (typeof e.rationale !== 'string') return null;

  const verb = coerceVerb(e.proposed_action);
  if (!verb) return null;

  // Source/verb consistency — don't try to archive a Todoist task.
  if (e.source === 'gmail' && !verb.kind.startsWith('gmail_')) return null;
  if (e.source === 'todoist' && !verb.kind.startsWith('todoist_')) return null;

  const action: TriageAction = {
    id: e.id,
    source: e.source,
    item_summary: e.item_summary,
    proposed_action: verb,
    rationale: e.rationale,
  };
  if (typeof e.account === 'string') action.account = e.account;
  if (typeof e.drill_key === 'string' && e.drill_key.length > 0) action.drill_key = e.drill_key;

  const routing = e.routing_suggestion;
  if (
    routing &&
    typeof routing === 'object' &&
    (routing as { target?: unknown }).target === 'todoist' &&
    typeof (routing as { payload?: { content?: unknown } }).payload?.content === 'string' &&
    typeof (routing as { reason?: unknown }).reason === 'string'
  ) {
    const {payload} = (routing as { payload: Record<string, unknown> });
    action.routing_suggestion = {
      target: 'todoist',
      payload: {
        content: payload.content as string,
        ...(typeof payload.project === 'string' ? { project: payload.project } : {}),
        ...(typeof payload.due_string === 'string' ? { due_string: payload.due_string } : {}),
      },
      reason: (routing as { reason: string }).reason,
    };
  }

  return action;
}

function coerceVerb(raw: unknown): TriageVerb | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const {kind} = (raw as { kind?: unknown });
  switch (kind) {
    case 'gmail_archive':
    case 'gmail_mark_read':
    case 'gmail_trash':
    case 'gmail_keep':
    case 'todoist_close':
    case 'todoist_keep':
      return { kind };
    case 'todoist_reschedule': {
      const due = (raw as { due_string?: unknown }).due_string;
      if (typeof due !== 'string' || due.length === 0) return null;
      return { kind: 'todoist_reschedule', due_string: due };
    }
    default:
      return null;
  }
}

/** Result of attempting a single triage action. */
export interface ActionOutcome {
  action: TriageAction;
  status: 'executed' | 'skipped' | 'failed';
  error?: string;
}

/**
 * Execute a single approved action against the live service API.
 * Keep callers responsible for the user-confirmation loop — this function
 * just dispatches on the verb.
 */
export async function executeAction(
  action: TriageAction,
  config: CallsheetConfig,
): Promise<ActionOutcome> {
  const verb = action.proposed_action;
  try {
    switch (verb.kind) {
      case 'gmail_keep':
      case 'todoist_keep':
        return { action, status: 'skipped' };

      case 'gmail_archive': {
        const client = getGmailClient(config.connectors?.gmail ?? {}, action.account);
        await archiveMessage(client, action.id);
        return { action, status: 'executed' };
      }
      case 'gmail_mark_read': {
        const client = getGmailClient(config.connectors?.gmail ?? {}, action.account);
        await markMessageRead(client, action.id);
        return { action, status: 'executed' };
      }
      case 'gmail_trash': {
        const client = getGmailClient(config.connectors?.gmail ?? {}, action.account);
        await trashMessage(client, action.id);
        return { action, status: 'executed' };
      }

      case 'todoist_close': {
        const ok = await callTodoistClose(action, config);
        return ok
          ? { action, status: 'executed' }
          : { action, status: 'failed', error: 'Todoist API rejected close.' };
      }
      case 'todoist_reschedule': {
        const ok = await callTodoistReschedule(action, verb.due_string, config);
        return ok
          ? { action, status: 'executed' }
          : { action, status: 'failed', error: 'Todoist API rejected reschedule.' };
      }
      default:
        return { action, status: 'failed', error: `Unknown verb kind` };
    }
  } catch (e) {
    return { action, status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Look up the Todoist token for an action's account. Mirrors the pattern
 * in core.ts closeTodoistTasks — keep them aligned.
 */
function resolveTodoistToken(action: TriageAction, config: CallsheetConfig): string | undefined {
  const accounts = (config.connectors?.todoist?.accounts ?? []) as {
    name: string;
    token_env: string;
  }[];
  if (accounts.length === 0) return undefined;
  const acct = action.account
    ? accounts.find((a) => a.name.toLowerCase() === action.account!.toLowerCase())
    : accounts[0];
  if (!acct) return undefined;
  return process.env[acct.token_env];
}

async function callTodoistClose(action: TriageAction, config: CallsheetConfig): Promise<boolean> {
  const token = resolveTodoistToken(action, config);
  if (!token) return false;
  const resp = await fetch(`https://api.todoist.com/api/v1/tasks/${action.id}/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  return resp.ok;
}

async function callTodoistReschedule(
  action: TriageAction,
  dueString: string,
  config: CallsheetConfig,
): Promise<boolean> {
  const token = resolveTodoistToken(action, config);
  if (!token) return false;
  const resp = await fetch(`https://api.todoist.com/api/v1/tasks/${action.id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ due_string: dueString }),
    signal: AbortSignal.timeout(10_000),
  });
  return resp.ok;
}

/**
 * Persist a session + its outcomes to disk. Keeps the same directory idiom
 * as feedback/ and auto_close/ logs.
 */
export function saveTriageSession(
  session: TriageSession,
  outcomes: ActionOutcome[],
  outputDir: string,
): string {
  const dir = join(outputDir, TRIAGE_OUTPUT_SUBDIR);
  mkdirSync(dir, { recursive: true });
  // Seconds-resolution ISO is enough for a manually-triggered tool and
  // avoids path-unsafe colons on Windows filesystems.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(dir, `triage_${stamp}.json`);
  writeFileSync(path, JSON.stringify({ session, outcomes }, null, 2));
  return path;
}

/**
 * Build a drill-down profile for the `[m]ore` interactive command.
 * Returns `null` when the action doesn't carry a drill_key.
 */
export function buildDrillProfile(action: TriageAction): TriageProfile | null {
  if (!action.drill_key) return null;

  if (action.source === 'gmail') {
    return {
      description: `Drill: gmail from ${action.drill_key}`,
      connectors: {
        gmail: {
          query: `from:${action.drill_key}`,
          max_messages: 100,
        },
      },
    };
  }
  // todoist
  return {
    description: `Drill: todoist project ${action.drill_key}`,
    connectors: {
      todoist: {
        projects: [action.drill_key],
        max_tasks: 100,
      },
    },
  };
}

/** Used by the CLI's --list-triage-profiles flag. */
export function listTriageProfiles(triageFile = DEFAULT_TRIAGE_FILE): string[] {
  if (!existsSync(triageFile)) return [];
  // Validation is cheap; surface any errors to the caller by throwing.
  const file = loadTriageFile(triageFile);
  return Object.keys(file.profiles).sort();
}
