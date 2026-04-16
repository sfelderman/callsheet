import type {
  ConnectorResult,
  ConnectorConfig,
  Brief,
  BriefSection,
  BriefItem,
  CallsheetConfig,
  AutoCloseRecommendation,
  Check,
  TriageProfile,
  TriageProfilesFile,
  TriageAction,
  TriageSession,
  TriageVerb,
} from '../src/types.js';

describe('types', () => {
  it('ConnectorResult should satisfy the interface', () => {
    const result: ConnectorResult = {
      source: 'test',
      description: 'A test connector',
      data: { key: 'value' },
      priorityHint: 'high',
    };
    expect(result.source).toBe('test');
    expect(result.priorityHint).toBe('high');
  });

  it('priorityHint should accept all valid values', () => {
    const hints: ConnectorResult['priorityHint'][] = ['high', 'normal', 'low'];
    expect(hints).toHaveLength(3);
  });

  it('Brief should support full structure', () => {
    const item: BriefItem = {
      label: 'Test item',
      time: '9:00 AM',
      note: 'important',
      checkbox: true,
      highlight: false,
      urgent: true,
    };
    const section: BriefSection = {
      heading: 'Schedule',
      items: [item],
      body: 'Some text',
    };
    const brief: Brief = {
      title: 'Daily Brief',
      subtitle: 'March 25',
      sections: [section],
    };

    expect(brief.title).toBe('Daily Brief');
    expect(brief.sections[0].items![0].urgent).toBe(true);
  });

  it('CallsheetConfig should allow optional fields', () => {
    const minimal: CallsheetConfig = {};
    expect(minimal.model).toBeUndefined();

    const full: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      printer: 'Brother',
      output_dir: 'output',
      credentials_dir: 'secrets',
      context: { family: 'Person1 + partner' },
      connectors: { weather: { enabled: true } },
      extras: [{ name: 'Joke', instruction: 'Add a dad joke' }],
      auto_close_tasks: true,
    };
    expect(full.auto_close_tasks).toBe(true);
  });

  it('AutoCloseRecommendation should have required fields', () => {
    const rec: AutoCloseRecommendation = {
      task_id: '123',
      task_content: 'Pay electric bill',
      person: 'Person1',
      reason: 'Payment confirmed in email',
    };
    expect(rec.task_id).toBe('123');
  });

  it('Check tuple should have icon, msg, detail', () => {
    const check: Check = ['✓', 'Token found', '/path/to/token'];
    expect(check).toHaveLength(3);
    expect(check[0]).toBe('✓');
  });

  it('ConnectorConfig should accept arbitrary keys', () => {
    const config: ConnectorConfig = {
      enabled: true,
      lat: 40.7,
      lon: -74.0,
      custom_field: 'value',
    };
    expect(config.enabled).toBe(true);
    expect(config.lat).toBe(40.7);
  });

  it('TriageProfile should nest gmail/todoist overrides', () => {
    const profile: TriageProfile = {
      description: 'Weekly cleanup',
      connectors: {
        gmail: { query: 'in:inbox', max_messages: 200 },
        todoist: { include_overdue_only: true, max_tasks: 100 },
      },
    };
    expect(profile.connectors.gmail?.max_messages).toBe(200);
    expect(profile.connectors.todoist?.include_overdue_only).toBe(true);
  });

  it('TriageProfilesFile should key profiles by name', () => {
    const file: TriageProfilesFile = {
      profiles: {
        default: { connectors: { gmail: { max_messages: 50 } } },
        stale_tasks: { connectors: { todoist: { include_older_than_days: 30 } } },
      },
    };
    expect(Object.keys(file.profiles)).toEqual(['default', 'stale_tasks']);
  });

  it('TriageVerb discriminated union should narrow on kind', () => {
    const verbs: TriageVerb[] = [
      { kind: 'gmail_archive' },
      { kind: 'gmail_mark_read' },
      { kind: 'gmail_trash' },
      { kind: 'gmail_keep' },
      { kind: 'todoist_close' },
      { kind: 'todoist_reschedule', due_string: 'tomorrow' },
      { kind: 'todoist_keep' },
    ];
    const reschedules = verbs.filter((v) => v.kind === 'todoist_reschedule');
    // Type narrows: due_string is accessible here
    expect(reschedules[0].kind === 'todoist_reschedule' && reschedules[0].due_string).toBe(
      'tomorrow',
    );
  });

  it('TriageAction should support optional routing + account', () => {
    const action: TriageAction = {
      id: 'msg_abc',
      source: 'gmail',
      account: 'Person 1',
      item_summary: 'Comcast autopay receipt',
      proposed_action: { kind: 'gmail_archive' },
      rationale: 'Auto-pay receipt — nothing actionable.',
      drill_key: 'billing@comcast.com',
      routing_suggestion: {
        target: 'todoist',
        payload: { content: 'Review Comcast bill', project: 'Finance' },
        reason: 'Monthly check-in opportunity.',
      },
    };
    expect(action.routing_suggestion?.target).toBe('todoist');
  });

  it('TriageSession should carry profile name + generated_at', () => {
    const session: TriageSession = {
      summary: '47 unread; 18 tasks >30d old.',
      profile: 'inbox_zero',
      actions: [],
      generated_at: new Date().toISOString(),
    };
    expect(session.profile).toBe('inbox_zero');
    expect(Array.isArray(session.actions)).toBe(true);
  });
});
