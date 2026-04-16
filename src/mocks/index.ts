/**
 * Mock mode entry point.
 *
 * Controls whether connectors talk to real APIs or a local mock server.
 * Set `CALLSHEET_MOCK_MODE=true` (or `1`/`yes`) to activate.
 * Override the default mock URL with `CALLSHEET_MOCK_URL`.
 */

const TRUTHY = new Set(['1', 'true', 'yes']);

/** The prefix prepended to ConnectorResult.description in mock mode. */
export const MOCK_PREFIX = '[MOCK DATA]';

/** Whether mock mode is currently active. */
export function isMockMode(): boolean {
  return TRUTHY.has((process.env.CALLSHEET_MOCK_MODE ?? '').toLowerCase());
}

/**
 * Returns the mock base URL (e.g. `http://localhost:4010`) when mock mode
 * is active, or `null` when running against real APIs.
 */
export function getMockBaseUrl(): string | null {
  if (!isMockMode()) return null;
  return process.env.CALLSHEET_MOCK_URL ?? 'http://localhost:4010';
}

export { startMockTodoistServer } from './todoist/server.js';
