/**
 * Triage — connector-aware inbox classification
 *
 * Goal: given one or more connectors' data (gmail, todoist, etc.), produce a
 * prioritised markdown triage doc that helps answer "what actually needs my
 * attention right now?"
 *
 * Design:
 * - Each connector type has its own Haiku prompt + category set (ConnectorTriageConfig)
 * - Haiku outputs only lean index-based classifications {i, c, u} — TypeScript
 *   joins those back with the original item data for display (no re-output of content)
 * - Results render as one markdown file, one ## section per connector
 *
 * Gmail categories:   respond → act → followup → read → archive → noise
 * Todoist categories: keep → reschedule → schedule → waiting → defer → drop
 *   (keep = genuinely urgent; reschedule = due date was a visibility hack)
 *
 * Entry point: classifyForTriage()
 * CLI: yarn triage [gmail] [todoist]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ConnectorResult, CallsheetConfig } from './types.js';
import { logUsage } from './usage.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// ── Lean Haiku output schema ──────────────────────────────────────────────────

interface HaikuClassification {
  i: number;           // index into the items array sent to Haiku
  c: string;           // category shortcode
  u: 'h' | 'm' | 'l'; // urgency
}

interface HaikuResponse {
  classifications: HaikuClassification[];
  patterns: { indices: number[]; tag: string }[];
}

// ── Rendered types (built by TypeScript, not Haiku) ──────────────────────────

export interface TriageItem {
  label: string;    // email subject OR task content
  meta?: string;    // "from sender" OR "in Project"
  date?: string;    // email date OR task due date
  category: string; // connector-specific category name
  urgency: 'high' | 'medium' | 'low';
}

export interface TriagePattern {
  description: string;
  suggestion: string;
}

export interface ConnectorTriageResult {
  source: string;
  items: TriageItem[];
  patterns: TriagePattern[];
  categoryOrder: string[];
  categoryLabel: Record<string, string>;
}

// ── Per-connector config ──────────────────────────────────────────────────────

interface RawItem {
  label: string;
  meta?: string;
  date?: string;
}

interface ConnectorTriageConfig {
  categoryOrder: string[];
  categoryLabel: Record<string, string>;
  buildPrompt: (contextBlock: string) => string;
  extractItems: (data: Record<string, unknown>) => RawItem[];
}

// ── Gmail config ──────────────────────────────────────────────────────────────

const GMAIL_TRIAGE_CONFIG: ConnectorTriageConfig = {
  categoryOrder: ['respond', 'act', 'followup', 'read', 'archive', 'noise'],
  categoryLabel: {
    respond: 'Respond',
    act: 'Act',
    followup: 'Follow-up',
    read: 'Read',
    archive: 'Archive',
    noise: 'Noise',
  },
  buildPrompt(contextBlock: string): string {
    return (
      'You are an email triage assistant. Classify each numbered email.\n\n' +
      'Categories:\n' +
      '- respond: needs a reply\n' +
      '- act: needs action but not a reply (pay, click, review)\n' +
      '- followup: waiting on someone else\n' +
      '- read: informational, no action\n' +
      '- archive: safe to archive\n' +
      '- noise: automated notification or unsubscribe candidate\n\n' +
      'Return ONLY valid JSON (no code fences):\n' +
      '{"classifications":[{"i":0,"c":"respond","u":"h"},...], "patterns":[{"indices":[1,5],"tag":"description"}]}\n\n' +
      'u values: h=high, m=medium, l=low. When in doubt lean toward archive or noise.\n\n' +
      contextBlock
    );
  },
  extractItems(data: Record<string, unknown>): RawItem[] {
    const accounts = (data.accounts ?? []) as Array<{
      emails?: Array<{ subject?: string; from?: string; date?: string; resolved?: boolean }>;
    }>;
    const items: RawItem[] = [];
    for (const account of accounts) {
      for (const email of account.emails ?? []) {
        if (email.resolved) continue;
        items.push({
          label: email.subject ?? '(no subject)',
          meta: email.from ? `from ${email.from}` : undefined,
          date: email.date,
        });
      }
    }
    return items;
  },
};

// ── Todoist config ────────────────────────────────────────────────────────────

const TODOIST_TRIAGE_CONFIG: ConnectorTriageConfig = {
  categoryOrder: ['keep', 'reschedule', 'schedule', 'waiting', 'defer', 'drop'],
  categoryLabel: {
    keep: 'Keep',
    reschedule: 'Reschedule',
    schedule: 'Schedule',
    waiting: 'Waiting',
    defer: 'Defer',
    drop: 'Drop',
  },
  buildPrompt(contextBlock: string): string {
    return (
      'You are a task triage assistant. Review each numbered task and classify it.\n\n' +
      'Categories:\n' +
      '- keep: genuine MUST-DO — due date is correct and the task is actually urgent today\n' +
      '- reschedule: due date is a visibility hack — not genuinely urgent, should be pushed out\n' +
      '- schedule: valid task that needs a real due date assigned\n' +
      '- waiting: blocked on someone else or an external dependency\n' +
      '- defer: fine in backlog, no date needed yet\n' +
      '- drop: no longer relevant, stale, or superseded\n\n' +
      'Task prefixes show context: TODAY/UPCOMING = has a due date. INBOX/BACKLOG = no date set.\n' +
      'For TODAY/UPCOMING: is the due date genuinely urgent (keep) or a fake urgency visibility hack (reschedule)?\n' +
      'For INBOX/BACKLOG: should it be scheduled, waited on, deferred, or dropped?\n\n' +
      'Return ONLY valid JSON (no code fences):\n' +
      '{"classifications":[{"i":0,"c":"keep","u":"h"},...], "patterns":[{"indices":[1,5],"tag":"description"}]}\n\n' +
      'u values: h=high, m=medium, l=low.\n\n' +
      contextBlock
    );
  },
  extractItems(data: Record<string, unknown>): RawItem[] {
    const accounts = (data.accounts ?? []) as Array<{
      today?: Array<{ content?: string; project?: string; dueDate?: string }>;
      upcoming?: Array<{ content?: string; project?: string; dueDate?: string }>;
      inbox?: Array<{ content?: string; project?: string }>;
      backlog?: Array<{ content?: string; project?: string }>;
    }>;
    const items: RawItem[] = [];
    for (const account of accounts) {
      for (const task of account.today ?? []) {
        items.push({
          label: `TODAY: ${task.content ?? '(no content)'}`,
          meta: task.project ? `in ${task.project}` : undefined,
          date: task.dueDate,
        });
      }
      for (const task of account.upcoming ?? []) {
        items.push({
          label: `UPCOMING: ${task.content ?? '(no content)'}`,
          meta: task.project ? `in ${task.project}` : undefined,
          date: task.dueDate,
        });
      }
      for (const task of account.inbox ?? []) {
        items.push({
          label: `INBOX: ${task.content ?? '(no content)'}`,
          meta: task.project ? `in ${task.project}` : undefined,
        });
      }
      for (const task of account.backlog ?? []) {
        items.push({
          label: `BACKLOG: ${task.content ?? '(no content)'}`,
          meta: task.project ? `in ${task.project}` : undefined,
        });
      }
    }
    return items;
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────

const CONNECTOR_CONFIGS: Record<string, ConnectorTriageConfig> = {
  gmail: GMAIL_TRIAGE_CONFIG,
  todoist: TODOIST_TRIAGE_CONFIG,
};

// ── Urgency ───────────────────────────────────────────────────────────────────

const URGENCY_EXPAND: Record<string, 'high' | 'medium' | 'low'> = {
  h: 'high',
  m: 'medium',
  l: 'low',
};

const URGENCY_ICON: Record<string, string> = {
  high: '🔴',
  medium: '🟡',
  low: '⚪',
};

// ── Render ────────────────────────────────────────────────────────────────────

/** Render a single connector's triage results as a markdown section. Exported for testing. */
export function renderConnectorSection(result: ConnectorTriageResult): string {
  const { source, items, patterns, categoryOrder, categoryLabel } = result;

  const byCategory = new Map<string, TriageItem[]>();
  for (const cat of categoryOrder) byCategory.set(cat, []);
  for (const item of items) {
    const fallback = categoryOrder[categoryOrder.length - 1];
    const bucket = byCategory.get(item.category) ?? byCategory.get(fallback)!;
    bucket.push(item);
  }

  const counts = categoryOrder
    .map((c) => {
      const n = byCategory.get(c)!.length;
      return n > 0 ? `${n} ${(categoryLabel[c] ?? c).toLowerCase()}` : null;
    })
    .filter(Boolean)
    .join(' · ');

  const title = source.charAt(0).toUpperCase() + source.slice(1);
  let md = `## ${title} — ${counts}\n\n`;

  for (const cat of categoryOrder) {
    const catItems = byCategory.get(cat)!;
    if (!catItems.length) continue;

    md += `### ${categoryLabel[cat] ?? cat} (${catItems.length})\n\n`;
    for (const item of catItems) {
      const icon = URGENCY_ICON[item.urgency] ?? '⚪';
      md += `${icon} **${item.label}**  \n`;
      if (item.meta || item.date) {
        md += `${[item.meta, item.date].filter(Boolean).join(' · ')}  \n`;
      }
      md += '\n';
    }
  }

  if (patterns.length > 0) {
    md += `#### Patterns\n\n`;
    for (const p of patterns) {
      md += `- **${p.description}** — ${p.suggestion}\n`;
    }
    md += '\n';
  }

  return md;
}

/**
 * Render all connector triage results as a full triage markdown document.
 * Exported for testing.
 */
export function renderMarkdown(results: ConnectorTriageResult[], today: string): string {
  const sources = results.map((r) => r.source);
  let md = `# Triage — ${today}\n\n`;
  md += `**Sources:** ${sources.join(', ')}\n\n`;

  for (const result of results) {
    md += `---\n\n`;
    md += renderConnectorSection(result);
  }

  return md;
}

// ── Classify one connector ────────────────────────────────────────────────────

async function classifyConnector(
  client: Anthropic,
  connectorResult: ConnectorResult,
  contextBlock: string,
  outputDir: string,
): Promise<ConnectorTriageResult | null> {
  const config = CONNECTOR_CONFIGS[connectorResult.source];
  if (!config) {
    console.log(`  No triage config for connector: ${connectorResult.source}, skipping`);
    return null;
  }

  const rawItems = config.extractItems(connectorResult.data);
  if (rawItems.length === 0) {
    console.log(`  No items to classify for: ${connectorResult.source}`);
    return {
      source: connectorResult.source,
      items: [],
      patterns: [],
      categoryOrder: config.categoryOrder,
      categoryLabel: config.categoryLabel,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const numberedList = rawItems
    .map((item, i) => {
      const parts = [`${i}. ${item.label}`];
      if (item.meta) parts.push(`   ${item.meta}`);
      if (item.date) parts.push(`   date: ${item.date}`);
      return parts.join('\n');
    })
    .join('\n');

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 2048,
    system: config.buildPrompt(contextBlock),
    messages: [
      {
        role: 'user',
        content: `Today is ${today}. Classify these ${rawItems.length} items:\n\n${numberedList}`,
      },
    ],
  });

  logUsage(
    outputDir,
    HAIKU_MODEL,
    'triage',
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  const responseText = (response.content[0] as { type: 'text'; text: string }).text.trim();
  let parsed: HaikuResponse;
  try {
    const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(responseText);
    parsed = JSON.parse(fenceMatch ? fenceMatch[1].trim() : responseText) as HaikuResponse;
  } catch {
    throw new Error(
      `Haiku returned invalid JSON for ${connectorResult.source}: ${responseText.slice(0, 200)}`,
    );
  }

  // Join Haiku classifications with original item data
  const items: TriageItem[] = [];
  for (const cls of parsed.classifications ?? []) {
    const rawItem = rawItems[cls.i];
    if (!rawItem) continue;
    items.push({
      label: rawItem.label,
      meta: rawItem.meta,
      date: rawItem.date,
      category: cls.c,
      urgency: URGENCY_EXPAND[cls.u] ?? 'low',
    });
  }

  // Build human-readable patterns from index-based tags
  const patterns: TriagePattern[] = (parsed.patterns ?? []).map((p) => {
    const tagged = p.indices.map((i) => rawItems[i]?.label ?? `item ${i}`);
    return {
      description: p.tag,
      suggestion: `Affects: ${tagged.slice(0, 3).join(', ')}${tagged.length > 3 ? ` (+${tagged.length - 3} more)` : ''}`,
    };
  });

  return {
    source: connectorResult.source,
    items,
    patterns,
    categoryOrder: config.categoryOrder,
    categoryLabel: config.categoryLabel,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run per-connector Haiku classification passes and write a triage markdown
 * file to `outputDir/triage_YYYY-MM-DD.md`.
 *
 * Each connector type gets its own Haiku call with a tailored prompt and
 * category set. Haiku outputs only lean index-based classifications; TypeScript
 * renders the full display by joining with the original item data.
 */
export async function classifyForTriage(
  client: Anthropic,
  results: ConnectorResult[],
  config: CallsheetConfig,
  outputDir: string,
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const contextBlock = buildContextBlock(config);

  const connectorResults: ConnectorTriageResult[] = [];
  for (const result of results) {
    const classified = await classifyConnector(client, result, contextBlock, outputDir);
    if (classified) connectorResults.push(classified);
  }

  const markdown =
    connectorResults.length === 0
      ? `# Triage — ${today}\n\nNo supported connectors found.\n`
      : renderMarkdown(connectorResults, today);

  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `triage_${today}.md`);
  writeFileSync(outputPath, markdown);
  console.log(`  Triage saved to ${outputPath}`);

  return markdown;
}

function buildContextBlock(config: CallsheetConfig): string {
  const ctx = config.context;
  if (!ctx) return '';
  const parts: string[] = ['User context:'];
  if (ctx.people) parts.push(`- People: ${ctx.people}`);
  if (ctx.work) parts.push(`- Work: ${ctx.work}`);
  if (ctx.location) parts.push(`- Location: ${ctx.location}`);
  return parts.join('\n');
}
