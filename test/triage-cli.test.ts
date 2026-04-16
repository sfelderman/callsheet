import { jest } from '@jest/globals';
import type { CallsheetConfig, TriageAction, TriageSession } from '../src/types.js';
import type { ActionOutcome } from '../src/triage.js';

// --- Mocks ----------------------------------------------------------------

const mockRunTriage = jest.fn<(...args: unknown[]) => Promise<TriageSession>>();
const mockExecuteAction = jest.fn<(...args: unknown[]) => Promise<ActionOutcome>>();
const mockSaveTriageSession = jest.fn<(...args: unknown[]) => string>(() => '/tmp/fake.json');
const mockBuildDrillProfile = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule('../src/triage.js', () => ({
  runTriage: mockRunTriage,
  executeAction: mockExecuteAction,
  saveTriageSession: mockSaveTriageSession,
  buildDrillProfile: mockBuildDrillProfile,
}));

type MockQuestion = jest.Mock<(q: string) => Promise<string>>;
type MockClose = jest.Mock<() => void>;

const mockQuestion: MockQuestion = jest.fn<(q: string) => Promise<string>>();
const mockClose: MockClose = jest.fn<() => void>();
const answers: string[] = [];
function queueAnswers(...xs: string[]): void {
  answers.length = 0;
  answers.push(...xs);
  mockQuestion.mockImplementation(async () => {
    const next = answers.shift();
    if (next === undefined) return '';
    return next;
  });
}

jest.unstable_mockModule('node:readline/promises', () => ({
  createInterface: jest.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

const { runTriageCli } = await import('../src/triage-cli.js');

// --- Helpers --------------------------------------------------------------

function makeAction(overrides: Partial<TriageAction> = {}): TriageAction {
  return {
    id: 'abc',
    source: 'gmail',
    item_summary: 'Receipt from Comcast',
    rationale: 'auto-pay confirmation',
    proposed_action: { kind: 'gmail_archive' },
    ...overrides,
  };
}

function makeSession(actions: TriageAction[], profile = 'default'): TriageSession {
  return {
    summary: `summary for ${profile}`,
    profile,
    actions,
    generated_at: new Date().toISOString(),
  };
}

// --- Tests ---------------------------------------------------------------

const config: CallsheetConfig = { output_dir: 'output', connectors: {} };

beforeEach(() => {
  jest.clearAllMocks();
  mockExecuteAction.mockImplementation(async (action) => ({
    action: action as TriageAction,
    status: 'executed',
  }));
});

describe('runTriageCli', () => {
  it('executes on "y", skips on "n", and persists a session log', async () => {
    const actions = [
      makeAction({ id: 'a1' }),
      makeAction({ id: 'a2', proposed_action: { kind: 'gmail_trash' } }),
    ];
    mockRunTriage.mockResolvedValueOnce(makeSession(actions));
    queueAnswers('y', '', 'n', '');

    await runTriageCli(config, 'default');

    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    expect((mockExecuteAction.mock.calls[0][0] as TriageAction).id).toBe('a1');
    expect(mockSaveTriageSession).toHaveBeenCalled();
    const outcomes = mockSaveTriageSession.mock.calls[0][1] as ActionOutcome[];
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].status).toBe('executed');
    expect(outcomes[1].status).toBe('skipped');
  });

  it('short-circuits on "q" without executing remaining actions', async () => {
    mockRunTriage.mockResolvedValueOnce(
      makeSession([makeAction({ id: 'a1' }), makeAction({ id: 'a2' })]),
    );
    queueAnswers('q');

    await runTriageCli(config, 'default');
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it('edits a todoist_reschedule due_string before executing', async () => {
    const action = makeAction({
      id: 't1',
      source: 'todoist',
      proposed_action: { kind: 'todoist_reschedule', due_string: 'tomorrow' },
    });
    mockRunTriage.mockResolvedValueOnce(makeSession([action]));
    queueAnswers('e', 'next monday', '');

    await runTriageCli(config, 'default');

    const executed = mockExecuteAction.mock.calls[0][0] as TriageAction;
    expect(executed.proposed_action).toEqual({
      kind: 'todoist_reschedule',
      due_string: 'next monday',
    });
  });

  it('runs a drill-down when the user picks "m" and walks the nested queue', async () => {
    const parent = makeAction({ id: 'p1', drill_key: 'news@example.com' });
    mockRunTriage
      .mockResolvedValueOnce(makeSession([parent]))
      .mockResolvedValueOnce(
        makeSession([makeAction({ id: 'n1' })], 'drill:news@example.com'),
      );
    mockBuildDrillProfile.mockReturnValueOnce({
      connectors: { gmail: { query: 'from:news@example.com' } },
    });
    // Nested: execute n1. Back to parent: skip.
    queueAnswers('m', 'y', '', 'n', '');

    await runTriageCli(config, 'default');

    expect(mockRunTriage).toHaveBeenCalledTimes(2);
    const drillArgs = mockRunTriage.mock.calls[1][1] as {
      profile: unknown;
      profileName: string;
    };
    expect(drillArgs.profileName).toBe('drill:news@example.com');
    // One nested executed + one parent skipped.
    const outcomes = mockSaveTriageSession.mock.calls[0][1] as ActionOutcome[];
    expect(outcomes.map((o) => o.status)).toEqual(['executed', 'skipped']);
  });

  it('returns early with an empty log when no actions are proposed', async () => {
    mockRunTriage.mockResolvedValueOnce(makeSession([]));
    await runTriageCli(config, 'default');
    expect(mockExecuteAction).not.toHaveBeenCalled();
    expect(mockSaveTriageSession).toHaveBeenCalled();
    const outcomes = mockSaveTriageSession.mock.calls[0][1] as ActionOutcome[];
    expect(outcomes).toEqual([]);
  });

  it('re-prompts on invalid input', async () => {
    mockRunTriage.mockResolvedValueOnce(makeSession([makeAction()]));
    queueAnswers('zzz', 'y', '');
    await runTriageCli(config, 'default');
    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
  });

  it('records failed outcomes when executeAction returns failure', async () => {
    mockExecuteAction.mockResolvedValueOnce({
      action: makeAction(),
      status: 'failed',
      error: 'boom',
    });
    mockRunTriage.mockResolvedValueOnce(makeSession([makeAction()]));
    queueAnswers('y', '');
    await runTriageCli(config, 'default');
    const outcomes = mockSaveTriageSession.mock.calls[0][1] as ActionOutcome[];
    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error).toBe('boom');
  });
});
