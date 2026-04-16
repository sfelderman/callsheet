#!/usr/bin/env tsx
/**
 * Anonymize a raw Todoist data dump for use as a mock fixture.
 *
 * Replaces personally identifiable content while preserving the structural
 * and temporal properties that matter for categorization testing.
 *
 * Usage:
 *   tsx scripts/anonymize-todoist-dump.ts <input.json> <output.json>
 *
 * The input file should match the fixture format:
 *   { "projects": [...], "tasks": [...], "completed": [...] }
 *
 * What gets anonymized:
 *   - Task/completed content  → deterministic placeholder text
 *   - Task/completed description → generic or removed
 *   - IDs → hashed (consistent, so project_id refs still match)
 *   - Project names → generic ("Project A", "Project B", etc.)
 *     except Inbox stays "Inbox"
 *
 * What is preserved (load-bearing for categorizer behavior):
 *   - due.date, due.is_recurring, priority, completed_at
 *   - due.string (rewritten to generic)
 *   - project structure and inbox_project flag
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const WORD_BANK = [
  'Review', 'Update', 'Schedule', 'Prepare', 'Follow up on', 'Check',
  'Submit', 'Complete', 'Draft', 'Send', 'Plan', 'Organize', 'Research',
  'Fix', 'Clean', 'Set up', 'Order', 'Call about', 'Finalize', 'Confirm',
];

const NOUN_BANK = [
  'report', 'document', 'meeting', 'project', 'task', 'invoice',
  'presentation', 'appointment', 'request', 'item', 'ticket', 'form',
  'proposal', 'budget', 'review', 'update', 'delivery', 'order',
  'reservation', 'schedule',
];

interface RawFixture {
  projects: Array<{ id: string; name: string; inbox_project?: boolean }>;
  tasks: Array<{
    id: string;
    content: string;
    description?: string;
    project_id?: string;
    priority?: number;
    due?: { date: string; string: string; is_recurring: boolean } | null;
  }>;
  completed: Array<{
    id: string;
    content: string;
    description?: string;
    project_id?: string;
    priority?: number;
    completed_at: string;
  }>;
}

/** Deterministic hash for ID anonymization. */
function hashId(original: string): string {
  return createHash('sha256').update(original).digest('hex').slice(0, 12);
}

/** Deterministic content replacement based on original ID hash. */
function generateContent(id: string, index: number): string {
  const hash = createHash('sha256').update(id).digest();
  const verbIdx = hash[0] % WORD_BANK.length;
  const nounIdx = hash[1] % NOUN_BANK.length;
  return `${WORD_BANK[verbIdx]} ${NOUN_BANK[nounIdx]} #${index + 1}`;
}

/** Rewrite due.string to generic version. */
function genericDueString(original: string): string {
  if (!original) return '';
  if (/every/i.test(original)) return 'every week';
  if (/today/i.test(original)) return 'today';
  if (/tomorrow/i.test(original)) return 'tomorrow';
  return 'upcoming';
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;

  if (!inputPath || !outputPath) {
    console.error('Usage: tsx scripts/anonymize-todoist-dump.ts <input.json> <output.json>');
    process.exit(1);
  }

  const raw = JSON.parse(await readFile(inputPath, 'utf-8')) as RawFixture;

  if (!Array.isArray(raw.projects) || !Array.isArray(raw.tasks)) {
    console.error('Invalid input: must have "projects" and "tasks" arrays at the top level.');
    process.exit(1);
  }

  // Build consistent ID mapping
  const idMap = new Map<string, string>();
  function mapId(original: string): string {
    if (!idMap.has(original)) {
      idMap.set(original, `anon_${hashId(original)}`);
    }
    return idMap.get(original)!;
  }

  // Anonymize projects
  const projectLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const projects = raw.projects.map((p, i) => ({
    id: mapId(p.id),
    name: p.inbox_project ? 'Inbox' : `Project ${projectLetters[i % 26]}`,
    ...(p.inbox_project ? { inbox_project: true } : {}),
  }));

  // Anonymize tasks
  const tasks = raw.tasks.map((t, i) => ({
    id: mapId(t.id),
    content: generateContent(t.id, i),
    ...(t.description ? { description: 'Task details' } : {}),
    ...(t.project_id ? { project_id: mapId(t.project_id) } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    due: t.due
      ? {
          date: t.due.date,
          string: genericDueString(t.due.string),
          is_recurring: t.due.is_recurring,
        }
      : null,
  }));

  // Anonymize completed
  const completed = (raw.completed ?? []).map((t, i) => ({
    id: mapId(t.id),
    content: generateContent(t.id, i + raw.tasks.length),
    ...(t.project_id ? { project_id: mapId(t.project_id) } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    completed_at: t.completed_at,
  }));

  const output = { projects, tasks, completed };

  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');

  console.log(`Anonymized fixture written to ${outputPath}`);
  console.log(`  ${projects.length} projects, ${tasks.length} tasks, ${completed.length} completed`);
  console.log(`  ${idMap.size} unique IDs mapped`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
