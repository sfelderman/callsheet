/**
 * Fixture loader for the mock Todoist server.
 *
 * Reads JSON fixtures from `fixtures/todoist/<name>.json` and expands
 * date placeholders so fixtures stay date-relative.
 *
 * Supported placeholders in `due.date` values:
 *   <TODAY>     → today's date (YYYY-MM-DD)
 *   <TODAY+N>   → N days from today
 *   <TODAY-N>   → N days before today
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

interface TodoistTaskFixture {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  priority?: number;
  due?: { date: string; string: string; is_recurring: boolean } | null;
}

interface CompletedTaskFixture {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  priority?: number;
  completed_at: string;
}

interface ProjectFixture {
  id: string;
  name: string;
  inbox_project?: boolean;
}

export interface Scenario {
  projects: ProjectFixture[];
  tasks: TodoistTaskFixture[];
  completed: CompletedTaskFixture[];
  /** Optional override for page size (default 50). */
  pageSize?: number;
}

const cache = new Map<string, Scenario>();

function fixturesDir(): string {
  return join(process.cwd(), 'fixtures', 'todoist');
}

/**
 * Expand `<TODAY>`, `<TODAY+N>`, `<TODAY-N>` placeholders in a string.
 */
function expandDatePlaceholders(value: string): string {
  const today = new Date();
  return value.replace(/<TODAY([+-]\d+)?>/g, (_match, offset?: string) => {
    const d = new Date(today);
    if (offset) d.setDate(d.getDate() + Number(offset));
    return d.toISOString().slice(0, 10);
  });
}

/**
 * Walk the scenario data and expand date placeholders in `due.date` fields.
 */
function expandDates(scenario: Scenario): Scenario {
  const tasks = scenario.tasks.map((t) => {
    if (!t.due) return t;
    return {
      ...t,
      due: {
        ...t.due,
        date: expandDatePlaceholders(t.due.date),
        string: expandDatePlaceholders(t.due.string),
      },
    };
  });
  return { ...scenario, tasks };
}

/**
 * Load a named scenario from `fixtures/todoist/<name>.json`.
 * Results are cached by name.
 */
export async function loadScenario(name: string): Promise<Scenario> {
  const cached = cache.get(name);
  if (cached) return cached;

  const filePath = join(fixturesDir(), `${name}.json`);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    const available = await listScenarios();
    throw new Error(
      `Mock scenario '${name}' not found at ${filePath}. ` +
        `Available: ${available.join(', ') || '(none)'}`,
    );
  }

  const data = JSON.parse(raw) as Scenario;
  if (!Array.isArray(data.projects) || !Array.isArray(data.tasks)) {
    throw new Error(
      `Invalid fixture ${filePath}: must have "projects" and "tasks" arrays at the top level.`,
    );
  }
  if (!Array.isArray(data.completed)) {
    data.completed = [];
  }

  const expanded = expandDates(data);
  cache.set(name, expanded);
  return expanded;
}

/** List available scenario names (filenames without `.json`). */
export async function listScenarios(): Promise<string[]> {
  try {
    const files = await readdir(fixturesDir());
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/** Clear the scenario cache (useful for tests). */
export function clearCache(): void {
  cache.clear();
}
