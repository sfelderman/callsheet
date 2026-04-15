import { jest } from '@jest/globals';
import type { ConnectorResult, CallsheetConfig } from '../src/types.js';
import type { ConnectorTriageResult } from '../src/triage.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.unstable_mockModule('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

const mockLogUsage = jest.fn();
jest.unstable_mockModule('../src/usage.js', () => ({
  logUsage: mockLogUsage,
}));

const mockMessagesCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

// Import after mocks
const { renderMarkdown, renderConnectorSection, classifyForTriage } = await import('../src/triage.js');
const Anthropic = (await import('@anthropic-ai/sdk')).default;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const gmailTriageResult: ConnectorTriageResult = {
  source: 'gmail',
  categoryOrder: ['respond', 'act', 'followup', 'read', 'archive', 'noise'],
  categoryLabel: {
    respond: 'Respond',
    act: 'Act',
    followup: 'Follow-up',
    read: 'Read',
    archive: 'Archive',
    noise: 'Noise',
  },
  items: [
    {
      label: 'Your invoice is ready',
      meta: 'from billing@example.com',
      date: '2026-03-31',
      category: 'act',
      urgency: 'high',
    },
    {
      label: 'Newsletter: Weekly Digest',
      meta: 'from news@example.com',
      date: '2026-03-30',
      category: 'noise',
      urgency: 'low',
    },
    {
      label: 'Can you review this PR?',
      meta: 'from coworker@example.com',
      date: '2026-03-31',
      category: 'respond',
      urgency: 'medium',
    },
  ],
  patterns: [
    {
      description: 'linkedin-recruiters',
      suggestion: 'Affects: recruiter1, recruiter2',
    },
  ],
};

const todoistTriageResult: ConnectorTriageResult = {
  source: 'todoist',
  categoryOrder: ['keep', 'reschedule', 'schedule', 'waiting', 'defer', 'drop'],
  categoryLabel: {
    keep: 'Keep',
    reschedule: 'Reschedule',
    schedule: 'Schedule',
    waiting: 'Waiting',
    defer: 'Defer',
    drop: 'Drop',
  },
  items: [
    {
      label: 'TODAY: Buy groceries',
      meta: 'in Personal',
      date: '2026-03-31',
      category: 'keep',
      urgency: 'high',
    },
    {
      label: 'TODAY: Research laptops',
      meta: 'in Work',
      date: '2026-03-31',
      category: 'reschedule',
      urgency: 'low',
    },
    {
      label: 'INBOX: Read design doc',
      meta: 'in Inbox',
      category: 'schedule',
      urgency: 'medium',
    },
  ],
  patterns: [],
};

const gmailConnectorResult: ConnectorResult = {
  source: 'gmail',
  description: 'Gmail data',
  data: {
    accounts: [
      {
        emails: [
          {
            subject: 'Your invoice is ready',
            from: 'billing@example.com',
            date: '2026-03-31',
            resolved: false,
          },
          {
            subject: 'Newsletter: Weekly Digest',
            from: 'news@example.com',
            date: '2026-03-30',
            resolved: false,
          },
        ],
      },
    ],
  },
  priorityHint: 'normal',
};

const todoistConnectorResult: ConnectorResult = {
  source: 'todoist',
  description: 'Todoist data',
  data: {
    accounts: [
      {
        today: [{ content: 'Buy groceries', project: 'Personal', dueDate: '2026-03-31' }],
        upcoming: [],
        inbox: [{ content: 'Read design doc', project: 'Inbox' }],
        backlog: [],
      },
    ],
  },
  priorityHint: 'high',
};

const sampleConfig: CallsheetConfig = {
  output_dir: 'output',
  context: {
    people: 'Sean, solo household',
    work: 'Software engineer, remote',
    location: 'San Francisco, CA',
  },
};

// ── Haiku response helper ─────────────────────────────────────────────────────

function mockHaikuLeanResponse(
  classifications: { i: number; c: string; u: string }[],
  patterns: { indices: number[]; tag: string }[] = [],
) {
  mockMessagesCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify({ classifications, patterns }) }],
    usage: { input_tokens: 500, output_tokens: 100 },
  });
}

// ── Tests: renderConnectorSection ────────────────────────────────────────────

describe('renderConnectorSection', () => {
  it('renders connector title with category counts', () => {
    const md = renderConnectorSection(gmailTriageResult);
    expect(md).toContain('## Gmail —');
    expect(md).toContain('1 respond');
    expect(md).toContain('1 act');
    expect(md).toContain('1 noise');
  });

  it('renders sections in category order (respond before noise)', () => {
    const md = renderConnectorSection(gmailTriageResult);
    const respondPos = md.indexOf('### Respond');
    const noisePos = md.indexOf('### Noise');
    expect(respondPos).toBeGreaterThan(-1);
    expect(noisePos).toBeGreaterThan(-1);
    expect(respondPos).toBeLessThan(noisePos);
  });

  it('renders urgency icons correctly', () => {
    const md = renderConnectorSection(gmailTriageResult);
    expect(md).toContain('🔴'); // high — invoice
    expect(md).toContain('🟡'); // medium — PR review
    expect(md).toContain('⚪'); // low — noise
  });

  it('renders item label and meta', () => {
    const md = renderConnectorSection(gmailTriageResult);
    expect(md).toContain('Your invoice is ready');
    expect(md).toContain('from billing@example.com');
  });

  it('renders patterns section', () => {
    const md = renderConnectorSection(gmailTriageResult);
    expect(md).toContain('#### Patterns');
    expect(md).toContain('linkedin-recruiters');
  });

  it('omits empty categories', () => {
    const md = renderConnectorSection(gmailTriageResult);
    expect(md).not.toContain('### Follow-up');
    expect(md).not.toContain('### Read');
    expect(md).not.toContain('### Archive');
  });

  it('omits patterns section when no patterns', () => {
    const md = renderConnectorSection(todoistTriageResult);
    expect(md).not.toContain('#### Patterns');
  });

  it('renders todoist-specific categories', () => {
    const md = renderConnectorSection(todoistTriageResult);
    expect(md).toContain('## Todoist —');
    expect(md).toContain('### Keep');
    expect(md).toContain('### Reschedule');
    expect(md).toContain('TODAY: Buy groceries');
    expect(md).toContain('TODAY: Research laptops');
  });
});

// ── Tests: renderMarkdown ─────────────────────────────────────────────────────

describe('renderMarkdown', () => {
  it('renders header with date and all sources', () => {
    const md = renderMarkdown([gmailTriageResult, todoistTriageResult], '2026-03-31');
    expect(md).toContain('# Triage — 2026-03-31');
    expect(md).toContain('**Sources:** gmail, todoist');
  });

  it('includes a section for each connector', () => {
    const md = renderMarkdown([gmailTriageResult, todoistTriageResult], '2026-03-31');
    expect(md).toContain('## Gmail');
    expect(md).toContain('## Todoist');
  });

  it('separates connectors with horizontal rules', () => {
    const md = renderMarkdown([gmailTriageResult, todoistTriageResult], '2026-03-31');
    expect(md).toContain('---');
  });

  it('renders a single-connector doc correctly', () => {
    const md = renderMarkdown([gmailTriageResult], '2026-03-31');
    expect(md).toContain('**Sources:** gmail');
    expect(md).not.toContain('## Todoist');
  });
});

// ── Tests: classifyForTriage ──────────────────────────────────────────────────

describe('classifyForTriage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('makes one Haiku call per supported connector', async () => {
    mockHaikuLeanResponse([{ i: 0, c: 'act', u: 'h' }]);
    mockHaikuLeanResponse([{ i: 0, c: 'keep', u: 'h' }]);
    const client = new Anthropic({ apiKey: 'test' });
    await classifyForTriage(
      client,
      [gmailConnectorResult, todoistConnectorResult],
      sampleConfig,
      'output',
    );
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it('writes a single triage file combining all connectors', async () => {
    mockHaikuLeanResponse([{ i: 0, c: 'act', u: 'h' }]);
    mockHaikuLeanResponse([{ i: 0, c: 'keep', u: 'h' }]);
    const client = new Anthropic({ apiKey: 'test' });
    await classifyForTriage(
      client,
      [gmailConnectorResult, todoistConnectorResult],
      sampleConfig,
      'output',
    );
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [writePath, content] = mockWriteFileSync.mock.calls[0] as [string, string];
    expect(writePath).toMatch(/triage_\d{4}-\d{2}-\d{2}\.md$/);
    expect(content).toContain('## Gmail');
    expect(content).toContain('## Todoist');
  });

  it('logs usage per connector with connector name in purpose', async () => {
    mockHaikuLeanResponse([{ i: 0, c: 'act', u: 'h' }]);
    const client = new Anthropic({ apiKey: 'test' });
    await classifyForTriage(client, [gmailConnectorResult], sampleConfig, 'output');
    expect(mockLogUsage).toHaveBeenCalledWith(
      'output',
      'claude-haiku-4-5-20251001',
      'triage',
      500,
      100,
    );
  });

  it('skips connectors without a triage config', async () => {
    const unknownConnector: ConnectorResult = {
      source: 'weather',
      description: 'Weather data',
      data: {},
      priorityHint: 'low',
    };
    const client = new Anthropic({ apiKey: 'test' });
    const result = await classifyForTriage(client, [unknownConnector], sampleConfig, 'output');
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(result).toContain('No supported connectors found');
  });

  it('strips code fences from Haiku response', async () => {
    const lean = { classifications: [{ i: 0, c: 'act', u: 'h' }], patterns: [] };
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(lean) + '\n```' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const client = new Anthropic({ apiKey: 'test' });
    await expect(
      classifyForTriage(client, [gmailConnectorResult], sampleConfig, 'output'),
    ).resolves.toContain('# Triage');
  });

  it('throws on invalid JSON response', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json at all' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const client = new Anthropic({ apiKey: 'test' });
    await expect(
      classifyForTriage(client, [gmailConnectorResult], sampleConfig, 'output'),
    ).rejects.toThrow('invalid JSON');
  });

  it('uses the Haiku model', async () => {
    mockHaikuLeanResponse([{ i: 0, c: 'act', u: 'h' }]);
    const client = new Anthropic({ apiKey: 'test' });
    await classifyForTriage(client, [gmailConnectorResult], sampleConfig, 'output');
    const call = mockMessagesCreate.mock.calls[0][0] as { model: string };
    expect(call.model).toBe('claude-haiku-4-5-20251001');
  });

  it('classifies todoist tasks with correct categories', async () => {
    mockHaikuLeanResponse([
      { i: 0, c: 'keep', u: 'h' },
      { i: 1, c: 'schedule', u: 'm' },
    ]);
    const client = new Anthropic({ apiKey: 'test' });
    const result = await classifyForTriage(
      client,
      [todoistConnectorResult],
      sampleConfig,
      'output',
    );
    expect(result).toContain('## Todoist');
    expect(result).toContain('### Keep');
    expect(result).toContain('TODAY: Buy groceries');
  });

  it('returns markdown string containing triage header', async () => {
    mockHaikuLeanResponse([{ i: 0, c: 'act', u: 'h' }]);
    const client = new Anthropic({ apiKey: 'test' });
    const result = await classifyForTriage(client, [gmailConnectorResult], sampleConfig, 'output');
    expect(typeof result).toBe('string');
    expect(result).toContain('# Triage');
  });
});
