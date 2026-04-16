/**
 * Integration tests for the Todoist connector against the local mock server.
 *
 * These tests boot the real mock HTTP server on a random port, set mock-mode
 * env vars, and run the actual connector code end-to-end — exercising the
 * real fetch path, pagination, categorization, and description prefixing.
 */

import { startMockTodoistServer } from '../../src/mocks/todoist/server.js';
import { clearCache } from '../../src/mocks/todoist/scenarios.js';
import type { MockServerHandle } from '../../src/mocks/todoist/server.js';

// We dynamically import the connector so it picks up env vars at call time
let create: typeof import('../../src/connectors/todoist.js').create;

beforeAll(async () => {
  const mod = await import('../../src/connectors/todoist.js');
  create = mod.create;
});

afterEach(() => {
  delete process.env.CALLSHEET_MOCK_MODE;
  delete process.env.CALLSHEET_MOCK_URL;
  delete process.env.CALLSHEET_MOCK_SCENARIO;
  delete process.env.TODOIST_TOKEN_PERSON1;
  clearCache();
});

function enableMockMode(url: string) {
  process.env.CALLSHEET_MOCK_MODE = 'true';
  process.env.CALLSHEET_MOCK_URL = url;
  process.env.TODOIST_TOKEN_PERSON1 = 'fake-token';
}

function makeConnector() {
  return create({
    enabled: true,
    accounts: [{ name: 'Person1', token_env: 'TODOIST_TOKEN_PERSON1' }],
  });
}

describe('todoist integration (mock server)', () => {
  let server: MockServerHandle;

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  it('should fetch typical-day scenario end-to-end', async () => {
    server = await startMockTodoistServer({ scenario: 'typical-day' });
    enableMockMode(server.url);

    const conn = makeConnector();
    const result = await conn.fetch();

    expect(result.source).toBe('todoist');
    expect(result.description).toMatch(/^\[MOCK DATA\]/);
    expect(result.priorityHint).toBe('high');

    const accounts = result.data.accounts as Record<string, unknown>[];
    expect(accounts).toHaveLength(1);

    const acct = accounts[0];
    expect(acct.person).toBe('Person1');

    // typical-day has tasks in every category
    expect((acct.today as unknown[]).length).toBeGreaterThan(0);
    expect((acct.inbox as unknown[]).length).toBeGreaterThan(0);
    expect((acct.upcoming as unknown[]).length).toBeGreaterThan(0);
    expect((acct.backlog as unknown[]).length).toBeGreaterThan(0);
    expect((acct.recently_completed as unknown[]).length).toBeGreaterThan(0);
  });

  it('should handle empty scenario gracefully', async () => {
    server = await startMockTodoistServer({ scenario: 'empty' });
    enableMockMode(server.url);

    const conn = makeConnector();
    const result = await conn.fetch();

    expect(result.description).toMatch(/^\[MOCK DATA\]/);

    const accounts = result.data.accounts as Record<string, unknown>[];
    const acct = accounts[0];
    expect((acct.today as unknown[]).length).toBe(0);
    expect((acct.inbox as unknown[]).length).toBe(0);
    expect((acct.upcoming as unknown[]).length).toBe(0);
    expect((acct.backlog as unknown[]).length).toBe(0);
    expect((acct.recently_completed as unknown[]).length).toBe(0);
  });

  it('should paginate when tasks exceed page size', async () => {
    server = await startMockTodoistServer({ scenario: 'overdue-heavy' });
    enableMockMode(server.url);

    const conn = makeConnector();
    const result = await conn.fetch();

    const accounts = result.data.accounts as Record<string, unknown>[];
    const acct = accounts[0];

    // overdue-heavy has 55 tasks with pageSize=10, so pagination must work
    const totalTasks =
      (acct.today as unknown[]).length +
      (acct.inbox as unknown[]).length +
      (acct.upcoming as unknown[]).length +
      (acct.backlog as unknown[]).length;
    expect(totalTasks).toBe(55);
  });

  it('should switch scenarios per-request via X-Mock-Scenario header', async () => {
    // Boot with typical-day but verify the server resolves correctly
    server = await startMockTodoistServer({ scenario: 'typical-day' });

    // Direct HTTP test of header-based scenario switching
    const resp = await fetch(`${server.url}/api/v1/projects`, {
      headers: {
        Authorization: 'Bearer fake',
        'X-Mock-Scenario': 'empty',
      },
    });
    const data = (await resp.json()) as { results: unknown[] };
    // empty scenario has 1 project (Inbox only)
    expect(data.results).toHaveLength(1);
  });

  it('should return 401 when Authorization header is missing', async () => {
    server = await startMockTodoistServer({ scenario: 'typical-day' });

    const resp = await fetch(`${server.url}/api/v1/projects`);
    expect(resp.status).toBe(401);
  });

  it('should return 503 for unknown scenario', async () => {
    server = await startMockTodoistServer({ scenario: 'typical-day' });

    const resp = await fetch(`${server.url}/api/v1/projects`, {
      headers: {
        Authorization: 'Bearer fake',
        'X-Mock-Scenario': 'nonexistent-scenario',
      },
    });
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: string; available: string[] };
    expect(body.error).toContain('nonexistent-scenario');
    expect(body.available).toContain('typical-day');
  });

  it('should return 404 for unknown routes', async () => {
    server = await startMockTodoistServer({ scenario: 'typical-day' });

    const resp = await fetch(`${server.url}/api/v1/unknown`, {
      headers: { Authorization: 'Bearer fake' },
    });
    expect(resp.status).toBe(404);
  });

  describe('regression: recurring overdue tasks', () => {
    it('should categorize recurring overdue tasks into today bucket', async () => {
      server = await startMockTodoistServer({ scenario: 'regression-recurring-overdue' });
      enableMockMode(server.url);

      const conn = makeConnector();
      const result = await conn.fetch();

      const accounts = result.data.accounts as Record<string, unknown>[];
      const acct = accounts[0];

      const todayIds = (acct.today as { id: string }[]).map((t) => t.id);
      const upcomingIds = (acct.upcoming as { id: string }[]).map((t) => t.id);

      // Both recurring tasks (one due today, one overdue by 2 days) should be in today
      expect(todayIds).toContain('rec_today');
      expect(todayIds).toContain('rec_overdue');

      // The future task should be in upcoming, not today
      expect(upcomingIds).toContain('future_task');
      expect(todayIds).not.toContain('future_task');

      // Description must be prefixed
      expect(result.description.startsWith('[MOCK DATA]')).toBe(true);
    });
  });
});
