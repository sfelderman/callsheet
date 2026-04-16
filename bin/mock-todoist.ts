#!/usr/bin/env tsx
/**
 * Standalone mock Todoist API server.
 *
 * Usage:
 *   yarn mock:todoist                          # default port 4010, scenario 'typical-day'
 *   yarn mock:todoist --port 3999              # custom port
 *   yarn mock:todoist --scenario empty         # different fixture
 *
 * Switch scenarios per-request with the X-Mock-Scenario header:
 *   curl -H "Authorization: Bearer fake" -H "X-Mock-Scenario: empty" \
 *     http://localhost:4010/api/v1/tasks
 */

import { program } from 'commander';
import { startMockTodoistServer } from '../src/mocks/todoist/server.js';
import { listScenarios } from '../src/mocks/todoist/scenarios.js';

program
  .name('mock-todoist')
  .description('Local mock Todoist API server for offline development')
  .option('-p, --port <number>', 'Port to listen on', '4010')
  .option('-s, --scenario <name>', 'Default scenario', process.env.CALLSHEET_MOCK_SCENARIO ?? 'typical-day')
  .parse();

const opts = program.opts<{ port: string; scenario: string }>();

async function main() {
  const port = Number(opts.port);
  const scenario = opts.scenario;

  const available = await listScenarios();

  const { url } = await startMockTodoistServer({ port, scenario });

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Mock Todoist API Server');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  URL:       ${url}`);
  console.log(`  Scenario:  ${scenario}`);
  console.log(`  Available: ${available.join(', ')}`);
  console.log('');
  console.log('  Switch per-request via header:');
  console.log('    X-Mock-Scenario: <name>');
  console.log('');
  console.log('  Example:');
  console.log(`    curl -H "Authorization: Bearer fake" ${url}/api/v1/tasks`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  // Clean shutdown on signals
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.log(`\n  Shutting down (${sig})...`);
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
