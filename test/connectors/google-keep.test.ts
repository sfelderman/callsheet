import { jest } from '@jest/globals';

const mockExecFile = jest.fn();
const mockExistsSync = jest.fn<(...args: unknown[]) => boolean>();
const mockReadFileSync = jest.fn<(...args: unknown[]) => string>();

jest.unstable_mockModule('node:child_process', () => ({
  execFile: mockExecFile,
}));

jest.unstable_mockModule('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

jest.unstable_mockModule('node:os', () => ({
  homedir: () => '/home/testuser',
}));

const { create, validate } = await import('../../src/connectors/google-keep.js');
const { PASS, FAIL, WARN, INFO } = await import('../../src/test-icons.js');

const NOW = new Date('2026-04-10T07:00:00Z').getTime();

function makeNote(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'abc123',
    localId: 'local456',
    title: 'Test Note',
    type: 'NOTE',
    text: 'Some content',
    labels: [],
    color: 'DEFAULT',
    pinned: false,
    archived: false,
    trashed: false,
    updated: new Date(NOW - 60 * 60 * 1000).toISOString(), // 1 hour ago
    created: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeKeepFile(
  notes: Record<string, unknown>[] = [],
  scrapedAt = new Date(NOW - 5 * 60 * 1000).toISOString(),
): string {
  return JSON.stringify({
    scraped_at: scrapedAt,
    sync_version: 'ACBwh0Zd',
    total_notes: notes.length,
    notes,
  });
}

function mockScraperSuccess() {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      (callback as (...a: unknown[]) => void)(null, '', '');
    },
  );
}

function mockScraperError(message: string) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      (callback as (...a: unknown[]) => void)(new Error(message), '', message);
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('google_keep connector', () => {
  describe('create', () => {
    it('should create a connector with correct name', () => {
      const conn = create({ enabled: true });
      expect(conn.name).toBe('google_keep');
    });

    it('should fetch notes and return ConnectorResult', async () => {
      const notes = [makeNote({ id: 'note1', title: 'Shopping' })];
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      expect(result.source).toBe('google_keep');
      expect(result.priorityHint).toBe('normal');
      expect(result.data.notes).toHaveLength(1);
      expect(result.data.filtered_count).toBe(1);
    });

    it('should invoke node with the scraper path', async () => {
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile());

      const conn = create({ enabled: true });
      await conn.fetch();

      expect(mockExecFile).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining([expect.stringContaining('keep-scraper.js')]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('should use custom scraper_path when configured', async () => {
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile());

      const conn = create({ enabled: true, scraper_path: '~/custom/scraper.js' });
      await conn.fetch();

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args[0]).toContain('custom/scraper.js');
    });

    it('should use custom data_file when configured', async () => {
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile());

      const conn = create({ enabled: true, data_file: '~/custom/keep-data.json' });
      await conn.fetch();

      expect(mockReadFileSync).toHaveBeenCalledWith(
        expect.stringContaining('custom/keep-data.json'),
        'utf8',
      );
    });

    it('should filter out archived notes by default', async () => {
      const notes = [
        makeNote({ id: '1', title: 'Active' }),
        makeNote({ id: '2', title: 'Archived', archived: true }),
      ];
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      expect(result.data.notes).toHaveLength(1);
      expect((result.data.notes as { title: string }[])[0].title).toBe('Active');
    });

    it('should include archived notes when include_archived is true', async () => {
      const notes = [
        makeNote({ id: '1', title: 'Active' }),
        makeNote({ id: '2', title: 'Archived', archived: true }),
      ];
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true, include_archived: true });
      const result = await conn.fetch();

      expect(result.data.notes).toHaveLength(2);
    });

    it('should filter out trashed notes by default', async () => {
      const notes = [
        makeNote({ id: '1', title: 'Active' }),
        makeNote({ id: '2', title: 'In Trash', trashed: true }),
      ];
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      expect(result.data.notes).toHaveLength(1);
    });

    it('should include trashed notes when include_trashed is true', async () => {
      const notes = [
        makeNote({ id: '1', title: 'Active' }),
        makeNote({ id: '2', title: 'In Trash', trashed: true }),
      ];
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true, include_trashed: true });
      const result = await conn.fetch();

      expect(result.data.notes).toHaveLength(2);
    });

    it('should filter notes by updated_days', async () => {
      const recentDate = new Date(NOW - 12 * 60 * 60 * 1000).toISOString(); // 12h ago
      const oldDate = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
      const notes = [
        makeNote({ id: '1', title: 'Recent', updated: recentDate }),
        makeNote({ id: '2', title: 'Old', updated: oldDate }),
      ];
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true, updated_days: 2 });
      const result = await conn.fetch();

      expect(result.data.notes).toHaveLength(1);
      expect((result.data.notes as { title: string }[])[0].title).toBe('Recent');
    });

    it('should filter notes by title prefix when titles is configured', async () => {
      const notes = [
        makeNote({ id: '1', title: 'Shopping list' }),
        makeNote({ id: '2', title: 'Packing for trip' }),
        makeNote({ id: '3', title: 'Random note' }),
      ];
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true, titles: ['Shopping', 'Packing'] });
      const result = await conn.fetch();

      expect(result.data.notes).toHaveLength(2);
    });

    it('should respect max_notes limit', async () => {
      const notes = Array.from({ length: 10 }, (_, i) => makeNote({ id: String(i), title: `Note ${i}` }));
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true, max_notes: 3, updated_days: 0 });
      const result = await conn.fetch();

      expect(result.data.notes).toHaveLength(3);
    });

    it('should set filtered_count before applying max_notes slice', async () => {
      const notes = Array.from({ length: 10 }, (_, i) => makeNote({ id: String(i), title: `Note ${i}` }));
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true, max_notes: 3, updated_days: 0 });
      const result = await conn.fetch();

      expect(result.data.filtered_count).toBe(10);
      expect(result.data.notes).toHaveLength(3);
    });

    it('should throw when scraper fails', async () => {
      mockScraperError('CDP unreachable');

      const conn = create({ enabled: true });
      await expect(conn.fetch()).rejects.toThrow('Google Keep scraper failed');
    });

    it('should throw when data file cannot be read', async () => {
      mockScraperSuccess();
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const conn = create({ enabled: true });
      await expect(conn.fetch()).rejects.toThrow('Google Keep data file read failed');
    });

    it('should throw on invalid JSON in data file', async () => {
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue('not valid json');

      const conn = create({ enabled: true });
      await expect(conn.fetch()).rejects.toThrow();
    });

    it('should include note count in description', async () => {
      const notes = [makeNote()];
      mockScraperSuccess();
      mockReadFileSync.mockReturnValue(makeKeepFile(notes));

      const conn = create({ enabled: true });
      const result = await conn.fetch();

      expect(result.description).toContain('1');
    });
  });

  describe('validate', () => {
    it('should pass when data file exists and is fresh', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(makeKeepFile());

      const checks = validate({ enabled: true });

      expect(checks.some(([icon]) => icon === PASS)).toBe(true);
      expect(checks.some(([icon]) => icon === FAIL)).toBe(false);
    });

    it('should fail when data file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const checks = validate({ enabled: true });

      expect(checks.some(([icon, msg]) => icon === FAIL && msg.includes('Data file not found'))).toBe(true);
    });

    it('should warn when data is stale', () => {
      const staleDate = new Date(NOW - 120 * 60 * 1000).toISOString(); // 120 min ago
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(makeKeepFile([], staleDate));

      const checks = validate({ enabled: true, max_stale_minutes: 60 });

      expect(checks.some(([icon, msg]) => icon === WARN && msg.includes('stale'))).toBe(true);
    });

    it('should pass freshness when data is within max_stale_minutes', () => {
      const freshDate = new Date(NOW - 30 * 60 * 1000).toISOString(); // 30 min ago
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(makeKeepFile([], freshDate));

      const checks = validate({ enabled: true, max_stale_minutes: 60 });

      expect(checks.some(([icon, msg]) => icon === PASS && msg.includes('fresh'))).toBe(true);
    });

    it('should show info for scraper path, title filters, max_notes, updated_days', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(makeKeepFile());

      const checks = validate({
        enabled: true,
        max_notes: 30,
        updated_days: 5,
        titles: ['Shopping'],
      });

      const infoMessages = checks.filter(([icon]) => icon === INFO).map(([, msg]) => msg);
      expect(infoMessages.some(m => m.includes('Shopping'))).toBe(true);
      expect(infoMessages.some(m => m.includes('30'))).toBe(true);
      expect(infoMessages.some(m => m.includes('5'))).toBe(true);
    });

    it('should warn when data file cannot be parsed', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('not valid json');

      const checks = validate({ enabled: true });

      expect(checks.some(([icon, msg]) => icon === WARN && msg.includes('parse'))).toBe(true);
    });
  });
});

    (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
