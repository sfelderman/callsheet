import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL } from '../test-icons.js';

const API = 'https://api.todoist.com/api/v1';

interface TodoistTask {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  priority?: number;
  due?: { date: string; string: string; is_recurring: boolean } | null;
  /** ISO-8601 timestamp when the task was added. Used by triage filters. */
  added_at?: string;
}

/**
 * Triage-only filter knobs read from the config. Applied to the flat task
 * list before bucketing; the daily brief sets none of these and gets its
 * usual behavior. Defined alongside the connector because the filtering
 * lives here — triage-profile.ts only validates the shape.
 */
export interface TodoistFilters {
  max_tasks?: number;
  include_overdue_only?: boolean;
  include_older_than_days?: number;
  projects?: string[];
  accounts?: string[];
}

interface CompletedTask {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  priority?: number;
  completed_at: string;
}

interface CompletedResponse {
  items: CompletedTask[];
  next_cursor?: string | null;
}

interface PaginatedResponse<T> {
  results: T[];
  next_cursor: string | null;
}

/**
 * Apply triage filters to the flat task list. Runs before bucketing so the
 * today/inbox/upcoming/backlog views all narrow consistently. Exported for
 * unit tests; the daily brief passes no filters and gets the full list.
 */
export function applyTodoistFilters(
  tasks: TodoistTask[],
  projectNameById: Record<string, string>,
  filters: TodoistFilters,
): TodoistTask[] {
  let out = tasks;

  if (filters.include_overdue_only) {
    const today = new Date().toISOString().slice(0, 10);
    out = out.filter((t) => t.due?.date && t.due.date < today);
  }

  if (typeof filters.include_older_than_days === 'number') {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - filters.include_older_than_days);
    const cutoffIso = cutoff.toISOString();
    // Tasks without a known added_at are conservatively excluded — we can't
    // prove they're old enough, and closing "unknown-age" tasks in a triage
    // session would be a bad default.
    out = out.filter((t) => typeof t.added_at === 'string' && t.added_at <= cutoffIso);
  }

  if (Array.isArray(filters.projects) && filters.projects.length) {
    const wanted = new Set(filters.projects);
    out = out.filter((t) => wanted.has(projectNameById[t.project_id ?? ''] ?? ''));
  }

  if (typeof filters.max_tasks === 'number' && out.length > filters.max_tasks) {
    // Stable sort: highest priority first, then soonest-due, then oldest added.
    // Keeps the most-triageable items when capping.
    out = [...out]
      .sort((a, b) => {
        const pDiff = (b.priority ?? 1) - (a.priority ?? 1);
        if (pDiff !== 0) return pDiff;
        const aDue = a.due?.date ?? '9999-12-31';
        const bDue = b.due?.date ?? '9999-12-31';
        if (aDue !== bDue) return aDue < bDue ? -1 : 1;
        const aAdd = a.added_at ?? '9999-12-31';
        const bAdd = b.added_at ?? '9999-12-31';
        if (aAdd < bAdd) return -1;
        if (aAdd > bAdd) return 1;
        return 0;
      })
      .slice(0, filters.max_tasks);
  }

  return out;
}

async function fetchAccount(
  token: string,
  label: string,
  filters: TodoistFilters = {},
): Promise<Record<string, unknown>> {
  const headers = { Authorization: `Bearer ${token}` };

  async function get<T = TodoistTask>(
    endpoint: string,
    params?: Record<string, string>,
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | null = null;

    do {
      const url = new URL(`${API}/${endpoint}`);
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      if (cursor) url.searchParams.set('cursor', cursor);

      const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`Todoist ${endpoint}: ${resp.status}`);
      const data = (await resp.json()) as PaginatedResponse<T>;
      all.push(...data.results);
      cursor = data.next_cursor;
    } while (cursor);

    return all;
  }

  const projectList = await get<{ id: string; name: string; inbox_project?: boolean }>('projects');
  const projects = Object.fromEntries(projectList.map((p) => [p.id, p.name]));
  const inboxId = projectList.find((p) => p.inbox_project)?.id;

  // Fetch all open tasks across all projects
  const rawTasks = await get('tasks');

  // Triage filters narrow the flat task list BEFORE bucketing so today /
  // inbox / upcoming / backlog views all shrink consistently when scoped.
  const allTasks = applyTodoistFilters(rawTasks, projects, filters);

  // Fetch recently completed tasks (last 3 days) so the memory system
  // can see what was resolved and stop re-flagging completed items.
  let recentlyCompleted: CompletedTask[] = [];
  try {
    const since = new Date();
    since.setDate(since.getDate() - 3);
    const until = new Date();
    const url = new URL(`${API}/tasks/completed/by_completion_date`);
    url.searchParams.set('since', since.toISOString());
    url.searchParams.set('until', until.toISOString());
    url.searchParams.set('limit', '50');
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as CompletedResponse;
      recentlyCompleted = data.items ?? [];
    }
  } catch {
    // Non-critical — skip if it fails
  }

  function simplify(t: TodoistTask) {
    return {
      id: t.id,
      content: t.content,
      description: (t.description ?? '').slice(0, 200),
      project: projects[t.project_id ?? ''] ?? '',
      priority: t.priority ?? 1,
      dueDate: t.due?.date ?? '',
      dueString: t.due?.string ?? '',
      isRecurring: t.due?.is_recurring ?? false,
    };
  }

  const today = new Date().toISOString().slice(0, 10);

  const todayTasks = allTasks.filter((t) => {
    if (!t.due) return false;
    return t.due.date <= today;
  });
  const inboxTasks = allTasks.filter((t) => t.project_id === inboxId && !t.due);
  const todayIds = new Set(todayTasks.map((t) => t.id));
  const inboxIds = new Set(inboxTasks.map((t) => t.id));
  const upcomingTasks = allTasks.filter((t) => {
    if (todayIds.has(t.id) || inboxIds.has(t.id)) return false;
    if (!t.due) return false;
    const sevenDays = new Date();
    sevenDays.setDate(sevenDays.getDate() + 7);
    return t.due.date <= sevenDays.toISOString().slice(0, 10);
  });
  const noDueTasks = allTasks.filter((t) => !t.due && t.project_id !== inboxId);

  return {
    person: label,
    today: todayTasks.map(simplify),
    inbox: inboxTasks.map(simplify),
    upcoming: upcomingTasks.map(simplify),
    backlog: noDueTasks.map(simplify),
    recently_completed: recentlyCompleted.map((t) => ({
      id: t.id,
      content: t.content,
      project: projects[t.project_id ?? ''] ?? '',
      completed_at: t.completed_at,
    })),
  };
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'todoist',
    description: 'Todoist — tasks, inbox, and upcoming for each person',

    async fetch(): Promise<ConnectorResult> {
      const accounts = (config.accounts ?? []) as {
        name: string;
        token_env: string;
      }[];
      // Triage profiles can inject the post-fetch filter knobs via the
      // same ConnectorConfig dictionary; unused keys on the daily-brief
      // path are a no-op. Account allowlisting is handled upstream in
      // applyProfileOverrides() so the connector never sees it.
      const filters: TodoistFilters = {
        max_tasks: config.max_tasks as number | undefined,
        include_overdue_only: config.include_overdue_only as boolean | undefined,
        include_older_than_days: config.include_older_than_days as number | undefined,
        projects: config.projects as string[] | undefined,
      };

      const results: Record<string, unknown>[] = [];

      for (const acct of accounts) {
        const token = process.env[acct.token_env] ?? '';
        if (!token) {
          console.log(`  Warning: ${acct.token_env} not set, skipping ${acct.name}`);
          continue;
        }
        results.push(await fetchAccount(token, acct.name, filters));
      }

      const totalToday = results.reduce((sum, r) => sum + (r.today as unknown[]).length, 0);
      const totalInbox = results.reduce((sum, r) => sum + (r.inbox as unknown[]).length, 0);
      const totalBacklog = results.reduce((sum, r) => sum + (r.backlog as unknown[]).length, 0);

      const totalCompleted = results.reduce(
        (sum, r) => sum + ((r.recently_completed as unknown[])?.length ?? 0),
        0,
      );

      return {
        source: 'todoist',
        description:
          `Todoist data for ${results.length} account(s). ` +
          `${totalToday} tasks due today/overdue, ${totalInbox} inbox items, ${totalBacklog} backlog items, ${totalCompleted} recently completed. ` +
          "Each account has 'today' (due today + overdue), 'inbox' (unsorted items in Inbox project), " +
          "'upcoming' (next 7 days), 'backlog' (tasks with no due date across all projects), " +
          "and 'recently_completed' (tasks finished in the last 3 days — use these to recognize resolved items " +
          'and do NOT re-flag completed tasks from memory). ' +
          'Priority 4 = highest (p1 in UI). ' +
          "Inbox items are not necessarily actionable today — they're things to be aware of or process.",
        data: { accounts: results },
        priorityHint: 'high',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const accounts = (config.accounts ?? []) as { name: string; token_env: string }[];

  if (!accounts.length) {
    checks.push([FAIL, 'No accounts configured', '']);
    return checks;
  }

  checks.push([PASS, `${accounts.length} account(s) configured`, '']);

  for (const acct of accounts) {
    const token = process.env[acct.token_env] ?? '';
    if (token) {
      const masked = token.length > 12 ? token.slice(0, 8) + '...' + token.slice(-4) : '***';
      checks.push([PASS, `${acct.name}: ${acct.token_env} is set`, masked]);
    } else {
      checks.push([FAIL, `${acct.name}: ${acct.token_env} is NOT set`, 'Add it to .env']);
    }
  }

  return checks;
}
