import { jest } from '@jest/globals';
import type { ConnectorConfig } from '../../src/types.js';
import { applyTodoistFilters } from '../../src/connectors/todoist.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TODOIST_TOKEN_PERSON1;
});

const { create, validate } = await import('../../src/connectors/todoist.js');
const { PASS, FAIL } = await import('../../src/test-icons.js');

describe('todoist connector', () => {
  const today = new Date().toISOString().slice(0, 10);

  const mockProjects = {
    results: [
      { id: 'proj1', name: 'Work', inbox_project: false },
      { id: 'proj2', name: 'Inbox', inbox_project: true },
    ],
    next_cursor: null,
  };

  const mockTasks = {
    results: [
      {
        id: 'task1',
        content: 'Buy groceries',
        description: 'Milk, eggs',
        project_id: 'proj2',
        priority: 4,
        due: { date: today, string: 'today', is_recurring: false },
      },
      {
        id: 'task2',
        content: 'Review PR',
        description: '',
        project_id: 'proj1',
        priority: 2,
        due: null,
      },
      {
        id: 'task3',
        content: 'Inbox item',
        project_id: 'proj2',
        priority: 1,
        due: null,
      },
    ],
    next_cursor: null,
  };

  const mockCompleted = {
    items: [
      {
        id: 'done1',
        content: 'Old task',
        project_id: 'proj1',
        completed_at: '2026-03-24T10:00:00Z',
      },
    ],
  };

  function setupMockFetch() {
    process.env.TODOIST_TOKEN_PERSON1 = 'test-token-123';
    globalThis.fetch = jest.fn(((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/projects')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockProjects),
        });
      }
      if (urlStr.includes('/completed/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockCompleted),
        });
      }
      if (urlStr.includes('/tasks')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockTasks),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof fetch);
  }

  describe('create', () => {
    it('should create a connector with correct name', () => {
      const conn = create({
        enabled: true,
        accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
      });
      expect(conn.name).toBe('todoist');
      expect(conn.description).toContain('Todoist');
    });

    it('should fetch and return accounts with categorized tasks', async () => {
      setupMockFetch();
      const conn = create({
        enabled: true,
        accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
      });
      const result = await conn.fetch();

      expect(result.source).toBe('todoist');
      expect(result.priorityHint).toBe('high');

      const accounts = result.data.accounts as Record<string, unknown>[];
      expect(accounts).toHaveLength(1);
      expect(accounts[0].person).toBe('Person1');
      expect((accounts[0].today as unknown[]).length).toBeGreaterThanOrEqual(0);
      expect(accounts[0].recently_completed).toBeDefined();
    });

    it('should skip accounts with missing tokens', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      // Don't set the env var
      const conn = create({
        enabled: true,
        accounts: [{ name: 'Missing', token_env: 'NONEXISTENT_TOKEN' }],
      });
      const result = await conn.fetch();

      const accounts = result.data.accounts as unknown[];
      expect(accounts).toHaveLength(0);
      logSpy.mockRestore();
    });

    it('should categorize tasks into today, inbox, upcoming, and backlog', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 3);
      const futureDate = tomorrow.toISOString().slice(0, 10);

      const farFuture = new Date();
      farFuture.setDate(farFuture.getDate() + 14);
      const farFutureDate = farFuture.toISOString().slice(0, 10);

      process.env.TODOIST_TOKEN_PERSON1 = 'test-token-123';
      globalThis.fetch = jest.fn(((url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes('/projects')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockProjects),
          });
        }
        if (urlStr.includes('/completed/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ items: [] }),
          });
        }
        if (urlStr.includes('/tasks')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                results: [
                  // Today task (due today)
                  { id: 't1', content: 'Due today', project_id: 'proj1', priority: 1, due: { date: today, string: 'today', is_recurring: false } },
                  // Upcoming task (due in 3 days, within 7-day window)
                  { id: 't2', content: 'Due soon', project_id: 'proj1', priority: 2, due: { date: futureDate, string: 'in 3 days', is_recurring: false } },
                  // Beyond 7-day window (should not be in upcoming)
                  { id: 't3', content: 'Far future', project_id: 'proj1', priority: 1, due: { date: farFutureDate, string: 'in 14 days', is_recurring: false } },
                  // Backlog (no due date, not in inbox)
                  { id: 't4', content: 'No due', project_id: 'proj1', priority: 1, due: null },
                  // Inbox item (no due date, in inbox project)
                  { id: 't5', content: 'Inbox item', project_id: 'proj2', priority: 1, due: null },
                ],
                next_cursor: null,
              }),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      }) as typeof fetch);

      const conn = create({
        enabled: true,
        accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
      });
      const result = await conn.fetch();
      const accounts = result.data.accounts as Record<string, unknown>[];
      const acct = accounts[0];

      expect((acct.today as { id: string }[]).some((t) => t.id === 't1')).toBe(true);
      expect((acct.upcoming as { id: string }[]).some((t) => t.id === 't2')).toBe(true);
      // Far future should NOT be in upcoming
      expect((acct.upcoming as { id: string }[]).some((t) => t.id === 't3')).toBe(false);
      expect((acct.backlog as { id: string }[]).some((t) => t.id === 't4')).toBe(true);
      expect((acct.inbox as { id: string }[]).some((t) => t.id === 't5')).toBe(true);
    });

    it('should handle multiple accounts', async () => {
      setupMockFetch();
      process.env.TODOIST_TOKEN_PARTNER = 'test-token-456';

      const conn = create({
        enabled: true,
        accounts: [
          { name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' },
          { name: 'Partner', token_env: 'TODOIST_TOKEN_PARTNER' },
        ],
      });
      const result = await conn.fetch();

      const accounts = result.data.accounts as Record<string, unknown>[];
      expect(accounts).toHaveLength(2);

      delete process.env.TODOIST_TOKEN_PARTNER;
    });
  });

  describe('validate', () => {
    it('should pass when accounts configured with valid tokens', () => {
      process.env.TODOIST_TOKEN_PERSON1 = 'test-token';
      const checks = validate({
        enabled: true,
        accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
      });
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });

    it('should fail when no accounts configured', () => {
      const checks = validate({ enabled: true, accounts: [] });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('should fail when token env var is missing', () => {
      const checks = validate({
        enabled: true,
        accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
      });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('should report number of accounts', () => {
      process.env.TODOIST_TOKEN_PERSON1 = 'token';
      const checks = validate({
        enabled: true,
        accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
      });
      expect(checks.some(([, msg]) => msg.includes('1 account'))).toBe(true);
    });
  });
});

describe('applyTodoistFilters (triage)', () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const projectsById = { p_work: 'Work', p_inbox: 'Inbox', p_fin: 'Finance' };

  const sample = [
    {
      id: 'a',
      content: 'Overdue work task',
      project_id: 'p_work',
      priority: 3,
      due: { date: yesterdayStr, string: 'yesterday', is_recurring: false },
      added_at: '2024-01-01T00:00:00Z', // ancient
    },
    {
      id: 'b',
      content: 'Due tomorrow finance',
      project_id: 'p_fin',
      priority: 2,
      due: { date: tomorrowStr, string: 'tomorrow', is_recurring: false },
      added_at: new Date().toISOString(),
    },
    {
      id: 'c',
      content: 'No due, inbox',
      project_id: 'p_inbox',
      priority: 1,
      due: null,
      // No added_at — conservatively excluded by older_than_days filter.
    },
    {
      id: 'd',
      content: 'Due today work',
      project_id: 'p_work',
      priority: 4,
      due: { date: today, string: 'today', is_recurring: false },
      added_at: '2024-02-01T00:00:00Z', // old
    },
  ];

  it('returns input unchanged when no filters given', () => {
    expect(applyTodoistFilters(sample, projectsById, {})).toEqual(sample);
  });

  it('include_overdue_only keeps only tasks with due.date before today', () => {
    const out = applyTodoistFilters(sample, projectsById, { include_overdue_only: true });
    expect(out.map((t) => t.id)).toEqual(['a']);
  });

  it('include_older_than_days filters by added_at and excludes unknown-age tasks', () => {
    const out = applyTodoistFilters(sample, projectsById, { include_older_than_days: 30 });
    // 'a' and 'd' are added in early 2024, 'b' is today, 'c' has no added_at.
    expect(out.map((t) => t.id).sort()).toEqual(['a', 'd']);
  });

  it('projects filter matches by resolved name', () => {
    const out = applyTodoistFilters(sample, projectsById, { projects: ['Work'] });
    expect(out.map((t) => t.id).sort()).toEqual(['a', 'd']);
  });

  it('projects filter ignores unknown project names', () => {
    const out = applyTodoistFilters(sample, projectsById, { projects: ['Nope'] });
    expect(out).toEqual([]);
  });

  it('max_tasks caps by priority, then due date, then age', () => {
    const out = applyTodoistFilters(sample, projectsById, { max_tasks: 2 });
    // Highest priority first: 'd' (p4), then 'a' (p3).
    expect(out.map((t) => t.id)).toEqual(['d', 'a']);
  });

  it('combines filters sequentially', () => {
    const out = applyTodoistFilters(sample, projectsById, {
      projects: ['Work'],
      max_tasks: 1,
    });
    // Work tasks are 'a' and 'd'; highest priority is 'd'.
    expect(out.map((t) => t.id)).toEqual(['d']);
  });
});
