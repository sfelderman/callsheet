import { jest } from '@jest/globals';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.EXIST_IO_TOKEN;
});

const { create, validate } = await import('../../src/connectors/exist-io.js');
const { PASS, FAIL, WARN, INFO } = await import('../../src/test-icons.js');

function mkPage<T>(results: T[]) {
  return { count: results.length, next: null, previous: null, results };
}

const moodAttr = {
  name: 'mood',
  label: 'Mood',
  group: { name: 'mood' },
  value_type: 0,
  values: [
    { date: '2026-04-17', value: 4 },
    { date: '2026-04-16', value: 3 },
  ],
};

const moodNoteAttr = {
  name: 'mood_note',
  label: 'Mood Note',
  template: 'mood_note',
  group: { name: 'mood' },
  value_type: 2,
  values: [
    { date: '2026-04-17', value: 'Shipped the thing. Tired but good.' },
    { date: '2026-04-16', value: '' },
    { date: '2026-04-15', value: null },
  ],
};

const deepWorkTagAttr = {
  name: 'deep_work',
  label: 'Deep Work',
  group: { name: 'custom' },
  value_type: 0,
  values: [
    { date: '2026-04-17', value: 1 },
    { date: '2026-04-16', value: 0 },
  ],
};

const exerciseTagAttr = {
  name: 'exercise',
  label: 'Exercise',
  group: { name: 'custom' },
  value_type: 0,
  values: [{ date: '2026-04-17', value: 1 }],
};

const stepsAttr = {
  name: 'steps',
  label: 'Steps',
  group: { name: 'activity' },
  value_type: 0,
  values: [{ date: '2026-04-17', value: 8421 }],
};

describe('exist_io connector', () => {
  function setupMockFetch(
    results: unknown[] = [moodAttr, moodNoteAttr, deepWorkTagAttr, exerciseTagAttr, stepsAttr],
    insights: unknown[] = [],
  ) {
    process.env.EXIST_IO_TOKEN = 'test-token';
    globalThis.fetch = jest.fn(((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/attributes/with-values/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mkPage(results)) });
      }
      if (urlStr.includes('/insights/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mkPage(insights)) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as typeof fetch);
  }

  describe('create', () => {
    it('returns a connector with correct name', () => {
      const conn = create({ enabled: true, token_env: 'EXIST_IO_TOKEN' });
      expect(conn.name).toBe('exist_io');
    });

    it('pivots attributes into per-day records', async () => {
      setupMockFetch();
      const conn = create({ enabled: true, token_env: 'EXIST_IO_TOKEN', lookback_days: 3 });
      const result = await conn.fetch();

      expect(result.source).toBe('exist_io');
      expect(result.priorityHint).toBe('normal');
      expect(result.data.lookback_days).toBe(3);

      const days = result.data.days as Array<Record<string, unknown>>;
      expect(days.length).toBe(2);

      const today = days.find((d) => d.date === '2026-04-17') as Record<string, unknown>;
      expect(today.mood).toBe(4);
      expect(today.mood_note).toBe('Shipped the thing. Tired but good.');
      expect(today.tags).toEqual(['deep work', 'exercise']);
      expect(today.metrics).toEqual({ steps: 8421 });

      const yesterday = days.find((d) => d.date === '2026-04-16') as Record<string, unknown>;
      expect(yesterday.mood).toBe(3);
      expect(yesterday.mood_note).toBeUndefined();
      expect(yesterday.tags).toEqual([]);
    });

    it('renders custom tag names with underscores as spaces', async () => {
      setupMockFetch([deepWorkTagAttr]);
      const conn = create({ enabled: true, token_env: 'EXIST_IO_TOKEN' });
      const result = await conn.fetch();
      const days = result.data.days as Array<{ tags: string[] }>;
      expect(days[0].tags).toEqual(['deep work']);
    });

    it('clamps lookback_days above 31 to the API max', async () => {
      setupMockFetch();
      const conn = create({ enabled: true, token_env: 'EXIST_IO_TOKEN', lookback_days: 365 });
      const result = await conn.fetch();
      expect(result.data.lookback_days).toBe(31);

      const mockFetch = globalThis.fetch as jest.Mock;
      const firstCall = mockFetch.mock.calls[0][0] as URL | string;
      const url = new URL(firstCall.toString());
      expect(url.searchParams.get('days')).toBe('31');
    });

    it('sends groups by default and attributes when explicitly set', async () => {
      setupMockFetch();
      const conn = create({
        enabled: true,
        token_env: 'EXIST_IO_TOKEN',
        attributes: ['mood', 'mood_note'],
      });
      await conn.fetch();
      const mockFetch = globalThis.fetch as jest.Mock;
      const url = new URL((mockFetch.mock.calls[0][0] as URL | string).toString());
      expect(url.searchParams.get('attributes')).toBe('mood,mood_note');
      expect(url.searchParams.get('groups')).toBeNull();
    });

    it('throws when token env var is missing', async () => {
      const conn = create({ enabled: true, token_env: 'EXIST_IO_TOKEN' });
      await expect(conn.fetch()).rejects.toThrow('EXIST_IO_TOKEN not set');
    });

    it('omits insights when include_insights is falsy', async () => {
      setupMockFetch();
      const conn = create({ enabled: true, token_env: 'EXIST_IO_TOKEN' });
      const result = await conn.fetch();
      expect(result.data.insights).toBeUndefined();
    });

    it('includes insights when include_insights is true', async () => {
      setupMockFetch(
        [moodAttr],
        [
          {
            text: 'Your mood tends to dip on Mondays.',
            target_date: '2026-04-17',
            priority: 2,
          },
        ],
      );
      const conn = create({
        enabled: true,
        token_env: 'EXIST_IO_TOKEN',
        include_insights: true,
      });
      const result = await conn.fetch();
      const insights = result.data.insights as Array<Record<string, unknown>>;
      expect(insights).toHaveLength(1);
      expect(insights[0].text).toBe('Your mood tends to dip on Mondays.');
      expect(insights[0].date).toBe('2026-04-17');
    });

    it('drops days that end up with no signal', async () => {
      setupMockFetch([
        {
          name: 'mood_note',
          group: { name: 'mood' },
          values: [
            { date: '2026-04-17', value: 'good' },
            { date: '2026-04-16', value: '' },
            { date: '2026-04-15', value: null },
          ],
        },
      ]);
      const conn = create({ enabled: true, token_env: 'EXIST_IO_TOKEN' });
      const result = await conn.fetch();
      const days = result.data.days as Array<{ date: string }>;
      expect(days.map((d) => d.date)).toEqual(['2026-04-17']);
    });
  });

  describe('validate', () => {
    it('passes when token is set', () => {
      process.env.EXIST_IO_TOKEN = 'abcdef12345678';
      const checks = validate({ enabled: true, token_env: 'EXIST_IO_TOKEN' });
      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
    });

    it('fails when token env var is not set', () => {
      const checks = validate({ enabled: true, token_env: 'EXIST_IO_TOKEN' });
      expect(checks.some(([icon]) => icon === FAIL)).toBe(true);
    });

    it('warns when lookback_days exceeds the API max', () => {
      process.env.EXIST_IO_TOKEN = 'x';
      const checks = validate({
        enabled: true,
        token_env: 'EXIST_IO_TOKEN',
        lookback_days: 90,
      });
      expect(checks.some(([icon, msg]) => icon === WARN && msg.includes('clamped'))).toBe(true);
    });

    it('reports configured groups', () => {
      process.env.EXIST_IO_TOKEN = 'x';
      const checks = validate({
        enabled: true,
        token_env: 'EXIST_IO_TOKEN',
        groups: ['mood', 'sleep'],
      });
      expect(checks.some(([icon, msg]) => icon === INFO && msg.includes('mood, sleep'))).toBe(true);
    });

    it('warns when neither groups nor attributes are configured', () => {
      process.env.EXIST_IO_TOKEN = 'x';
      const checks = validate({ enabled: true, token_env: 'EXIST_IO_TOKEN' });
      expect(checks.some(([icon, msg]) => icon === WARN && msg.includes('defaulting to'))).toBe(
        true,
      );
    });
  });
});
