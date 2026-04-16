/**
 * Mock Todoist API server.
 *
 * A zero-dependency HTTP server (node:http) that serves the three GET
 * endpoints consumed by src/connectors/todoist.ts:
 *
 *   GET /api/v1/projects
 *   GET /api/v1/tasks
 *   GET /api/v1/tasks/completed/by_completion_date
 *
 * Fixture data comes from fixtures/todoist/<scenario>.json via the
 * scenarios module. The active scenario can be switched per-request
 * via the `X-Mock-Scenario` header.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadScenario, listScenarios, type Scenario } from './scenarios.js';

const DEFAULT_PAGE_SIZE = 50;

export interface MockServerOptions {
  /** Port to bind. 0 = random (recommended for tests). */
  port?: number;
  /** Default scenario name. Falls back to CALLSHEET_MOCK_SCENARIO, then 'typical-day'. */
  scenario?: string;
}

export interface MockServerHandle {
  /** Full base URL, e.g. `http://localhost:4010`. */
  url: string;
  /** Bound port number. */
  port: number;
  /** Gracefully shut down the server. */
  close: () => Promise<void>;
}

/**
 * Start the mock Todoist API server.
 */
export async function startMockTodoistServer(
  opts: MockServerOptions = {},
): Promise<MockServerHandle> {
  const defaultScenario = opts.scenario ?? process.env.CALLSHEET_MOCK_SCENARIO ?? 'typical-day';

  async function resolveScenario(req: IncomingMessage): Promise<Scenario> {
    const headerScenario = req.headers['x-mock-scenario'] as string | undefined;
    const name = headerScenario ?? defaultScenario;
    return loadScenario(name);
  }

  /**
   * Paginate an array using cursor-based pagination.
   * Cursor is a stringified offset.
   */
  function paginate<T>(items: T[], cursor: string | null, pageSize: number) {
    const offset = cursor ? Number(cursor) : 0;
    const page = items.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    const nextCursor = nextOffset < items.length ? String(nextOffset) : null;
    return { page, nextCursor };
  }

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth check — require any non-empty Bearer token
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || auth.length <= 7) {
      json(res, 401, { error: 'Unauthorized — missing or empty Bearer token' });
      return;
    }

    const { pathname, searchParams } = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const cursor = searchParams.get('cursor');

    let scenario: Scenario;
    try {
      scenario = await resolveScenario(req);
    } catch (e) {
      const available = await listScenarios();
      json(res, 503, {
        error: (e as Error).message,
        available,
      });
      return;
    }

    const pageSize = scenario.pageSize ?? DEFAULT_PAGE_SIZE;

    if (pathname === '/api/v1/projects') {
      const { page, nextCursor } = paginate(scenario.projects, cursor, pageSize);
      json(res, 200, { results: page, next_cursor: nextCursor });
      return;
    }

    if (pathname === '/api/v1/tasks' && !pathname.includes('completed')) {
      const { page, nextCursor } = paginate(scenario.tasks, cursor, pageSize);
      json(res, 200, { results: page, next_cursor: nextCursor });
      return;
    }

    if (pathname === '/api/v1/tasks/completed/by_completion_date') {
      // The connector reads this as { items: [...] } — not { results }
      const { page, nextCursor } = paginate(scenario.completed, cursor, pageSize);
      json(res, 200, { items: page, next_cursor: nextCursor });
      return;
    }

    json(res, 404, { error: `mock: unknown route ${pathname}` });
  }

  const server: Server = createServer((req, res) => {
    handleRequest(req, res).catch((e: unknown) => {
      json(res, 500, { error: `mock: internal error — ${(e as Error).message}` });
    });
  });

  const port = opts.port ?? 0;

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind'));
        return;
      }
      const boundPort = addr.port;
      const url = `http://127.0.0.1:${boundPort}`;
      resolve({
        url,
        port: boundPort,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
