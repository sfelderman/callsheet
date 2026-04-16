import { jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallsheetConfig, TriageAction } from '../src/types.js';

// --- Mocks ----------------------------------------------------------------

const mockMessagesCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

const mockFetchAll = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockBuildDataPayload = jest.fn(() => '<payload>');
jest.unstable_mockModule('../src/core.js', () => ({
  fetchAll: mockFetchAll,
  buildDataPayload: mockBuildDataPayload,
  stripJsonCodeFences: (s: string) => s.trim(),
}));

const mockLoadTriageFile = jest.fn<(...args: unknown[]) => unknown>();
const mockResolveProfile = jest.fn<(...args: unknown[]) => unknown>();
const mockApplyProfileOverrides = jest.fn((cfg: CallsheetConfig) => cfg);
jest.unstable_mockModule('../src/triage-profile.js', () => ({
  loadTriageFile: mockLoadTriageFile,
  resolveProfile: mockResolveProfile,
  applyProfileOverrides: mockApplyProfileOverrides,
}));

const mockGetGmailClient = jest.fn(() => ({ fake: true }));
const mockArchiveMessage = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockMarkMessageRead = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockTrashMessage = jest.fn<(...args: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../src/connectors/gmail-mutate.js', () => ({
  getGmailClient: mockGetGmailClient,
  archiveMessage: mockArchiveMessage,
  markMessageRead: mockMarkMessageRead,
  trashMessage: mockTrashMessage,
}));

jest.unstable_mockModule('../src/usage.js', () => ({
  logUsage: jest.fn(),
}));

const {
  runTriage,
  executeAction,
  parseTriageResponse,
  buildDrillProfile,
  saveTriageSession,
} = await import('../src/triage.js');

// --- parseTriageResponse --------------------------------------------------

describe('parseTriageResponse', () => {
  it('parses a valid response', () => {
    const json = JSON.stringify({
      summary: 'Looks quiet.',
      actions: [
        {
          id: 'msg1',
          source: 'gmail',
          item_summary: 'Comcast receipt',
          proposed_action: { kind: 'gmail_archive' },
          rationale: 'Auto-pay receipt.',
          drill_key: 'billing@comcast.com',
          routing_suggestion: null,
        },
      ],
    });
    const out = parseTriageResponse(json);
    expect(out.summary).toBe('Looks quiet.');
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].proposed_action.kind).toBe('gmail_archive');
    expect(out.actions[0].drill_key).toBe('billing@comcast.com');
    expect(out.actions[0].routing_suggestion).toBeUndefined();
  });

  it('preserves routing_suggestion when valid', () => {
    const json = JSON.stringify({
      summary: 's',
      actions: [
        {
          id: 'msg2',
          source: 'gmail',
          item_summary: 'Task-like email',
          proposed_action: { kind: 'gmail_keep' },
          rationale: 'looks like a task',
          routing_suggestion: {
            target: 'todoist',
            payload: { content: 'Send contract', project: 'Work', due_string: 'friday' },
            reason: 'deadline',
          },
        },
      ],
    });
    const out = parseTriageResponse(json);
    expect(out.actions[0].routing_suggestion).toEqual({
      target: 'todoist',
      payload: { content: 'Send contract', project: 'Work', due_string: 'friday' },
      reason: 'deadline',
    });
  });

  it('drops actions with missing id/source/rationale', () => {
    const json = JSON.stringify({
      summary: 's',
      actions: [
        { source: 'gmail', item_summary: 'a', proposed_action: { kind: 'gmail_archive' }, rationale: 'r' }, // no id
        {
          id: 'ok',
          source: 'gmail',
          item_summary: 'real',
          proposed_action: { kind: 'gmail_archive' },
          rationale: 'r',
        },
      ],
    });
    const out = parseTriageResponse(json);
    expect(out.actions.map((a) => a.id)).toEqual(['ok']);
  });

  it('drops actions whose verb does not match source', () => {
    const json = JSON.stringify({
      summary: 's',
      actions: [
        {
          id: 'bad',
          source: 'gmail',
          item_summary: 'x',
          proposed_action: { kind: 'todoist_close' },
          rationale: 'r',
        },
      ],
    });
    const out = parseTriageResponse(json);
    expect(out.actions).toHaveLength(0);
  });

  it('requires due_string on todoist_reschedule', () => {
    const json = JSON.stringify({
      summary: 's',
      actions: [
        {
          id: 't1',
          source: 'todoist',
          item_summary: 'task',
          proposed_action: { kind: 'todoist_reschedule' },
          rationale: 'r',
        },
      ],
    });
    expect(parseTriageResponse(json).actions).toHaveLength(0);
  });

  it('throws on non-JSON input', () => {
    expect(() => parseTriageResponse('not json')).toThrow(/not valid JSON/);
  });

  it('throws when summary is missing', () => {
    expect(() => parseTriageResponse(JSON.stringify({ actions: [] }))).toThrow(/summary/);
  });
});

// --- runTriage -------------------------------------------------------------

describe('runTriage', () => {
  const baseConfig: CallsheetConfig = {
    model: 'claude-test',
    output_dir: 'output',
    connectors: { gmail: { enabled: true }, todoist: { enabled: true } },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockLoadTriageFile.mockReturnValue({
      profiles: {
        default: { connectors: { gmail: { query: 'in:inbox' } } },
      },
    });
    mockResolveProfile.mockImplementation((_file: unknown, name: string) => ({
      description: `profile ${name}`,
      connectors: { gmail: {} },
    }));
    mockApplyProfileOverrides.mockImplementation((cfg: CallsheetConfig) => cfg);
    mockFetchAll.mockResolvedValue({
      results: [
        { source: 'gmail', description: 'x', data: { accounts: [] }, priorityHint: 'normal' },
      ],
      issues: [],
    });
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: 'summary text',
            actions: [
              {
                id: 'msg1',
                source: 'gmail',
                item_summary: 'Email 1',
                proposed_action: { kind: 'gmail_archive' },
                rationale: 'newsletter',
              },
            ],
          }),
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
  });

  it('loads profile, fetches scoped data, and returns a session', async () => {
    const session = await runTriage(baseConfig, 'default');
    expect(session.profile).toBe('default');
    expect(session.summary).toBe('summary text');
    expect(session.actions).toHaveLength(1);
    expect(session.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mockLoadTriageFile).toHaveBeenCalled();
    expect(mockFetchAll).toHaveBeenCalled();
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-test', max_tokens: 4096 }),
    );
  });

  it('uses an in-memory profile when opts.profile is provided', async () => {
    const session = await runTriage(baseConfig, {
      profile: { connectors: { gmail: { query: 'from:x@example.com' } } },
      profileName: 'drill:x@example.com',
    });
    expect(mockLoadTriageFile).not.toHaveBeenCalled();
    expect(session.profile).toBe('drill:x@example.com');
  });

  it('throws when no data is fetched', async () => {
    mockFetchAll.mockResolvedValueOnce({ results: [], issues: [] });
    await expect(runTriage(baseConfig, 'default')).rejects.toThrow(/no data/i);
  });

  it('throws when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runTriage(baseConfig, 'default')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

// --- executeAction ---------------------------------------------------------

describe('executeAction', () => {
  const config: CallsheetConfig = {
    connectors: {
      gmail: { credentials_dir: 'secrets', accounts: [{ name: 'Primary' }] },
      todoist: { accounts: [{ name: 'Alice', token_env: 'TODOIST_ALICE' }] },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TODOIST_ALICE = 'fake';
    globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 200 }),
    );
  });

  afterEach(() => {
    delete process.env.TODOIST_ALICE;
  });

  it('skips gmail_keep without API calls', async () => {
    const action: TriageAction = {
      id: 'm',
      source: 'gmail',
      item_summary: '',
      rationale: '',
      proposed_action: { kind: 'gmail_keep' },
    };
    const out = await executeAction(action, config);
    expect(out.status).toBe('skipped');
    expect(mockArchiveMessage).not.toHaveBeenCalled();
  });

  it('skips todoist_keep without API calls', async () => {
    const action: TriageAction = {
      id: 't',
      source: 'todoist',
      item_summary: '',
      rationale: '',
      proposed_action: { kind: 'todoist_keep' },
    };
    expect((await executeAction(action, config)).status).toBe('skipped');
  });

  it('dispatches gmail_archive to archiveMessage', async () => {
    const action: TriageAction = {
      id: 'abc',
      source: 'gmail',
      account: 'Primary',
      item_summary: '',
      rationale: '',
      proposed_action: { kind: 'gmail_archive' },
    };
    const out = await executeAction(action, config);
    expect(out.status).toBe('executed');
    expect(mockArchiveMessage).toHaveBeenCalledWith(expect.anything(), 'abc');
  });

  it('dispatches gmail_trash to trashMessage', async () => {
    const action: TriageAction = {
      id: 'abc',
      source: 'gmail',
      item_summary: '',
      rationale: '',
      proposed_action: { kind: 'gmail_trash' },
    };
    await executeAction(action, config);
    expect(mockTrashMessage).toHaveBeenCalledWith(expect.anything(), 'abc');
  });

  it('marks failed when the gmail mutator throws', async () => {
    mockArchiveMessage.mockRejectedValueOnce(new Error('boom'));
    const out = await executeAction(
      {
        id: 'x',
        source: 'gmail',
        item_summary: '',
        rationale: '',
        proposed_action: { kind: 'gmail_archive' },
      },
      config,
    );
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/boom/);
  });

  it('calls todoist close endpoint with bearer token', async () => {
    const action: TriageAction = {
      id: 'task1',
      source: 'todoist',
      account: 'Alice',
      item_summary: '',
      rationale: '',
      proposed_action: { kind: 'todoist_close' },
    };
    const out = await executeAction(action, config);
    expect(out.status).toBe('executed');
    const call = (globalThis.fetch as jest.Mock).mock.calls[0];
    const url = call[0];
    const init = call[1] as RequestInit;
    expect(url.toString()).toMatch(/\/tasks\/task1\/close$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake');
  });

  it('calls todoist update with due_string for reschedule', async () => {
    const action: TriageAction = {
      id: 'task2',
      source: 'todoist',
      account: 'Alice',
      item_summary: '',
      rationale: '',
      proposed_action: { kind: 'todoist_reschedule', due_string: 'next monday' },
    };
    const out = await executeAction(action, config);
    expect(out.status).toBe('executed');
    const init = (globalThis.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ due_string: 'next monday' });
  });

  it('fails todoist actions when no token is available', async () => {
    delete process.env.TODOIST_ALICE;
    const action: TriageAction = {
      id: 'task3',
      source: 'todoist',
      account: 'Alice',
      item_summary: '',
      rationale: '',
      proposed_action: { kind: 'todoist_close' },
    };
    const out = await executeAction(action, config);
    expect(out.status).toBe('failed');
  });
});

// --- buildDrillProfile -----------------------------------------------------

describe('buildDrillProfile', () => {
  it('returns null when drill_key is missing', () => {
    expect(
      buildDrillProfile({
        id: 'a',
        source: 'gmail',
        item_summary: '',
        rationale: '',
        proposed_action: { kind: 'gmail_keep' },
      }),
    ).toBeNull();
  });

  it('builds a gmail drill profile from sender email', () => {
    const profile = buildDrillProfile({
      id: 'a',
      source: 'gmail',
      item_summary: '',
      rationale: '',
      drill_key: 'sender@example.com',
      proposed_action: { kind: 'gmail_keep' },
    });
    expect(profile?.connectors.gmail?.query).toBe('from:sender@example.com');
    expect(profile?.connectors.gmail?.max_messages).toBeGreaterThan(0);
  });

  it('builds a todoist drill profile from project name', () => {
    const profile = buildDrillProfile({
      id: 't',
      source: 'todoist',
      item_summary: '',
      rationale: '',
      drill_key: 'Finance',
      proposed_action: { kind: 'todoist_keep' },
    });
    expect(profile?.connectors.todoist?.projects).toEqual(['Finance']);
  });
});

// --- saveTriageSession -----------------------------------------------------

describe('saveTriageSession', () => {
  it('writes session + outcomes to output/triage/*.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-out-'));
    try {
      const path = saveTriageSession(
        {
          summary: 'done',
          profile: 'default',
          actions: [],
          generated_at: new Date().toISOString(),
        },
        [],
        dir,
      );
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.session.summary).toBe('done');
      expect(Array.isArray(parsed.outcomes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
