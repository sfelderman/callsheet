import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { CallsheetConfig, TriageAction, TriageSession, TriageVerb } from './types.js';
import {
  runTriage,
  executeAction,
  saveTriageSession,
  buildDrillProfile,
  type ActionOutcome,
  type RunTriageOptions,
} from './triage.js';

/**
 * Interactive CLI driver for a triage session. Wraps runTriage + executeAction
 * with a readline loop; each action offers [y]es / [n]o / [e]dit / [s]kip /
 * [m]ore / [q]uit. A [m]ore request synthesizes a drill-down profile for the
 * same sender (gmail) or project (todoist) and runs a nested triage pass,
 * whose actions are walked before returning to the main queue.
 *
 * Kept deliberately separate from triage.ts so a future dashboard can reuse
 * runTriage / executeAction without dragging readline in.
 */

export interface TriageCliOptions extends RunTriageOptions {
  /** Max nested drill-downs from a single session (safety net). */
  maxDrillDepth?: number;
}

const VERB_LABELS: Record<TriageVerb['kind'], string> = {
  gmail_archive: 'Archive',
  gmail_mark_read: 'Mark read',
  gmail_trash: 'Trash',
  gmail_keep: 'Keep (no-op)',
  todoist_close: 'Close',
  todoist_reschedule: 'Reschedule',
  todoist_keep: 'Keep (no-op)',
};

function describeVerb(verb: TriageVerb): string {
  if (verb.kind === 'todoist_reschedule') {
    return `${VERB_LABELS[verb.kind]} → "${verb.due_string}"`;
  }
  return VERB_LABELS[verb.kind];
}

function formatCounts(actions: TriageAction[]): string {
  const counts = new Map<string, number>();
  for (const a of actions) {
    counts.set(a.proposed_action.kind, (counts.get(a.proposed_action.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join('  ');
}

function printSummary(session: TriageSession): void {
  console.log('\n' + '='.repeat(72));
  console.log(`Profile: ${session.profile}`);
  console.log(session.summary);
  if (session.actions.length) {
    console.log(`\n${session.actions.length} item(s) — ${formatCounts(session.actions)}`);
  }
  console.log('='.repeat(72) + '\n');
}

/**
 * Prompt the user for a single character from a fixed set. Loops on empty /
 * invalid input. Case-insensitive. Returns the lowercase char.
 */
async function promptChoice(
  rl: readline.Interface,
  question: string,
  valid: string[],
): Promise<string> {
  const set = new Set(valid.map((c) => c.toLowerCase()));
  for (;;) {
    const raw = (await rl.question(question)).trim().toLowerCase();
    const ch = raw.slice(0, 1);
    if (set.has(ch)) return ch;
    console.log(`  Please enter one of: ${valid.join(', ')}`);
  }
}

/**
 * Edit loop — currently only `todoist_reschedule` has user-facing knobs.
 * Returns the (possibly new) verb, or null if the user bailed.
 */
async function editVerb(rl: readline.Interface, verb: TriageVerb): Promise<TriageVerb | null> {
  if (verb.kind === 'todoist_reschedule') {
    const next = (await rl.question(`  New due_string [${verb.due_string}]: `)).trim();
    if (!next) return verb;
    return { kind: 'todoist_reschedule', due_string: next };
  }
  console.log('  Edit is only supported for todoist_reschedule; skipping.');
  return null;
}

async function handleRouting(rl: readline.Interface, action: TriageAction): Promise<void> {
  const r = action.routing_suggestion;
  if (!r) return;
  console.log(`\n  Routing suggestion → ${r.target}: ${r.payload.content}`);
  if (r.payload.project) console.log(`    project: ${r.payload.project}`);
  if (r.payload.due_string) console.log(`    due: ${r.payload.due_string}`);
  console.log(`    reason: ${r.reason}`);
  console.log('  (v1 surfaces routing as a note only — the task is not created automatically.)');
  // Just acknowledge; v1 is recommendations only.
  await rl.question('  [enter to continue] ');
}

interface WalkResult {
  outcomes: ActionOutcome[];
  quit: boolean;
}

/**
 * Walk one action queue to completion. `depth` controls how deep a [m]ore
 * request may recurse. Returns the outcomes plus a flag indicating the user
 * asked to quit the whole session (bubbles up past nested drills).
 */
async function walkActions(
  actions: TriageAction[],
  config: CallsheetConfig,
  rl: readline.Interface,
  depth: number,
  maxDepth: number,
): Promise<WalkResult> {
  const outcomes: ActionOutcome[] = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    console.log(`\n[${i + 1}/${actions.length}] ${action.source}: ${action.item_summary}`);
    if (action.account) console.log(`  account: ${action.account}`);
    console.log(`  proposed: ${describeVerb(action.proposed_action)}`);
    console.log(`  rationale: ${action.rationale}`);

    const options: string[] = ['y', 'n', 's', 'q'];
    if (action.proposed_action.kind === 'todoist_reschedule') options.push('e');
    if (action.drill_key && depth < maxDepth) options.push('m');

    const prompt = `  [${options.join('/')}] `;
    const choice = await promptChoice(rl, prompt, options);

    let verb = action.proposed_action;
    let decided: 'run' | 'skip' | 'quit' = 'skip';
    switch (choice) {
      case 'y':
        decided = 'run';
        break;
      case 'n':
      case 's':
        decided = 'skip';
        console.log('  skipped.');
        break;
      case 'e': {
        const edited = await editVerb(rl, verb);
        if (edited) {
          verb = edited;
          decided = 'run';
        } else {
          decided = 'skip';
        }
        break;
      }
      case 'm': {
        if (!action.drill_key) {
          decided = 'skip';
          break;
        }
        const drill = buildDrillProfile(action);
        if (!drill) {
          console.log('  (no drill profile available — skipping)');
          decided = 'skip';
          break;
        }
        console.log(`\n  -- drilling into ${action.source}: ${action.drill_key} --`);
        try {
          const nested = await runTriage(config, {
            profile: drill,
            profileName: `drill:${action.drill_key}`,
          });
          printSummary(nested);
          const sub = await walkActions(nested.actions, config, rl, depth + 1, maxDepth);
          outcomes.push(...sub.outcomes);
          if (sub.quit) return { outcomes, quit: true };
        } catch (e) {
          console.log(`  drill failed: ${e instanceof Error ? e.message : e}`);
        }
        // After drill-down, re-ask for the original action.
        i--;
        continue;
      }
      case 'q':
        return { outcomes, quit: true };
      default:
        break;
    }

    if (decided === 'run') {
      const exec = verb === action.proposed_action ? action : { ...action, proposed_action: verb };
      const outcome = await executeAction(exec, config);
      outcomes.push(outcome);
      if (outcome.status === 'executed') {
        console.log('  \u2713 executed');
      } else if (outcome.status === 'skipped') {
        console.log('  (no-op)');
      } else {
        console.log(`  \u2717 failed: ${outcome.error ?? 'unknown error'}`);
      }
    } else {
      outcomes.push({ action, status: 'skipped' });
    }

    await handleRouting(rl, action);
  }
  return { outcomes, quit: false };
}

function printOutcomeSummary(outcomes: ActionOutcome[]): void {
  const counts = { executed: 0, skipped: 0, failed: 0 };
  for (const o of outcomes) counts[o.status]++;
  console.log(
    `\nDone. ${counts.executed} executed · ${counts.skipped} skipped · ${counts.failed} failed`,
  );
  if (counts.failed > 0) {
    console.log('\nFailures:');
    for (const o of outcomes.filter((x) => x.status === 'failed')) {
      console.log(`  - ${o.action.source}:${o.action.id} — ${o.error ?? '?'}`);
    }
  }
}

/**
 * Top-level entry point used by `cli.ts --triage`. Builds the session,
 * walks it interactively, executes approved actions, and persists a log.
 */
export async function runTriageCli(
  config: CallsheetConfig,
  opts: string | TriageCliOptions = 'default',
): Promise<void> {
  const maxDrillDepth = typeof opts === 'string' ? 2 : (opts.maxDrillDepth ?? 2);

  const session = await runTriage(config, opts);
  printSummary(session);

  if (session.actions.length === 0) {
    console.log('No actions proposed — nothing to triage.');
    saveTriageSession(session, [], config.output_dir ?? 'output');
    return;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const { outcomes } = await walkActions(session.actions, config, rl, 0, maxDrillDepth);
    printOutcomeSummary(outcomes);
    const path = saveTriageSession(session, outcomes, config.output_dir ?? 'output');
    console.log(`\nSession log: ${path}`);
  } finally {
    rl.close();
  }
}
