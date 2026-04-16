import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateTriageProfiles,
  loadTriageFile,
  resolveProfile,
  applyProfileOverrides,
} from '../src/triage-profile.js';
import type { CallsheetConfig, TriageProfilesFile } from '../src/types.js';

describe('validateTriageProfiles', () => {
  it('accepts a minimal valid file', () => {
    const issues = validateTriageProfiles({
      profiles: {
        default: { connectors: { gmail: { query: 'in:inbox', max_messages: 50 } } },
      },
    });
    expect(issues).toEqual([]);
  });

  it('accepts all supported gmail + todoist keys', () => {
    const baseConfig: CallsheetConfig = {
      connectors: {
        gmail: { accounts: [{ name: 'primary' }] },
        todoist: { accounts: [{ name: 'Person 1', token_env: 'T1' }] },
      },
    };
    const issues = validateTriageProfiles(
      {
        profiles: {
          full: {
            description: 'everything',
            connectors: {
              gmail: {
                query: 'in:inbox',
                max_messages: 10,
                trash_max_age: '3d',
                pinned_labels: ['Travel'],
                accounts: ['primary'],
              },
              todoist: {
                max_tasks: 50,
                include_overdue_only: true,
                include_older_than_days: 14,
                projects: ['Finance'],
                accounts: ['Person 1'],
              },
            },
          },
        },
      },
      baseConfig,
    );
    expect(issues).toEqual([]);
  });

  it('rejects a non-object root', () => {
    const issues = validateTriageProfiles('nope');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/Root must be an object/);
  });

  it('rejects a missing profiles key', () => {
    const issues = validateTriageProfiles({});
    expect(issues[0].message).toMatch(/'profiles' object/);
  });

  it('rejects an empty profiles map', () => {
    const issues = validateTriageProfiles({ profiles: {} });
    expect(issues[0].message).toMatch(/No profiles defined/);
  });

  it('flags unknown top-level profile keys', () => {
    const issues = validateTriageProfiles({
      profiles: { default: { connectors: { gmail: {} }, extra: 'nope' } },
    });
    expect(issues.find((i) => i.message.includes("Unknown profile key 'extra'"))).toBeDefined();
  });

  it("requires a 'connectors' object with at least one supported connector", () => {
    const issues = validateTriageProfiles({
      profiles: { empty: { connectors: {} } },
    });
    expect(issues.find((i) => i.message.includes('at least one supported'))).toBeDefined();
  });

  it('flags unsupported connectors with a suggestion when close', () => {
    const issues = validateTriageProfiles({
      profiles: { p: { connectors: { gmial: { query: 'x' } } } },
    });
    const msg = issues.find((i) => i.path === 'connectors.gmial')?.message;
    expect(msg).toMatch(/Unsupported connector 'gmial'/);
    expect(msg).toMatch(/Did you mean 'gmail'/);
  });

  it('rejects unknown gmail override keys with a "did you mean" hint', () => {
    const issues = validateTriageProfiles({
      profiles: { p: { connectors: { gmail: { maxMessages: 50 } } } },
    });
    const msg = issues.find((i) => i.path === 'connectors.gmail.maxMessages')?.message;
    expect(msg).toMatch(/Unknown gmail override key 'maxMessages'/);
    expect(msg).toMatch(/Did you mean 'max_messages'/);
  });

  it('rejects wrong-typed gmail values', () => {
    const issues = validateTriageProfiles({
      profiles: {
        p: { connectors: { gmail: { query: 123, max_messages: -4, pinned_labels: [1, 2] } } },
      },
    });
    expect(issues.some((i) => i.path === 'connectors.gmail.query')).toBe(true);
    expect(issues.some((i) => i.path === 'connectors.gmail.max_messages')).toBe(true);
    expect(issues.some((i) => i.path === 'connectors.gmail.pinned_labels')).toBe(true);
  });

  it('rejects wrong-typed todoist values', () => {
    const issues = validateTriageProfiles({
      profiles: {
        p: {
          connectors: {
            todoist: {
              max_tasks: 'lots',
              include_overdue_only: 'yes',
              include_older_than_days: 0,
              projects: 'not-an-array',
            },
          },
        },
      },
    });
    expect(issues.some((i) => i.path === 'connectors.todoist.max_tasks')).toBe(true);
    expect(issues.some((i) => i.path === 'connectors.todoist.include_overdue_only')).toBe(true);
    expect(issues.some((i) => i.path === 'connectors.todoist.include_older_than_days')).toBe(true);
    expect(issues.some((i) => i.path === 'connectors.todoist.projects')).toBe(true);
  });

  it('flags account references that do not exist in base config', () => {
    const baseConfig: CallsheetConfig = {
      connectors: {
        todoist: { accounts: [{ name: 'Alice', token_env: 'T' }] },
      },
    };
    const issues = validateTriageProfiles(
      { profiles: { p: { connectors: { todoist: { accounts: ['Bob'] } } } } },
      baseConfig,
    );
    expect(issues[0].message).toMatch(/Account 'Bob' is not configured/);
  });

  it('skips account cross-check when base config has no accounts array', () => {
    const baseConfig: CallsheetConfig = { connectors: { gmail: {} } };
    const issues = validateTriageProfiles(
      { profiles: { p: { connectors: { gmail: { accounts: ['primary'] } } } } },
      baseConfig,
    );
    expect(issues).toEqual([]);
  });
});

describe('loadTriageFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'triage-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws a clear message when the file is missing', () => {
    expect(() => loadTriageFile(join(tmp, 'missing.yaml'))).toThrow(
      /Triage profile file not found/,
    );
  });

  it('throws on invalid YAML', () => {
    const file = join(tmp, 'triage.yaml');
    writeFileSync(file, 'profiles:\n  broken: : :');
    expect(() => loadTriageFile(file)).toThrow(/Failed to parse/);
  });

  it('aggregates every validation issue into the error message', () => {
    const file = join(tmp, 'triage.yaml');
    writeFileSync(
      file,
      [
        'profiles:',
        '  a:',
        '    connectors:',
        '      gmail:',
        '        bogus: 1',
        '  b:',
        '    connectors:',
        '      todoist:',
        '        include_overdue_only: maybe',
      ].join('\n'),
    );
    try {
      loadTriageFile(file);
      fail('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/\[a:connectors.gmail.bogus\]/);
      expect(msg).toMatch(/\[b:connectors.todoist.include_overdue_only\]/);
    }
  });

  it('loads a valid file and returns the typed payload', () => {
    const file = join(tmp, 'triage.yaml');
    writeFileSync(
      file,
      [
        'profiles:',
        '  default:',
        '    description: cleanup',
        '    connectors:',
        '      gmail:',
        '        query: in:inbox',
        '        max_messages: 50',
      ].join('\n'),
    );
    const result = loadTriageFile(file);
    expect(result.profiles.default.description).toBe('cleanup');
    expect(result.profiles.default.connectors.gmail?.max_messages).toBe(50);
  });
});

describe('resolveProfile', () => {
  const file: TriageProfilesFile = {
    profiles: {
      default: { connectors: { gmail: {} } },
      inbox_zero: { connectors: { gmail: { query: 'in:inbox' } } },
    },
  };

  it('returns the named profile', () => {
    expect(resolveProfile(file, 'inbox_zero').connectors.gmail?.query).toBe('in:inbox');
  });

  it('lists available profiles when the name is missing', () => {
    expect(() => resolveProfile(file, 'nope')).toThrow(
      /'nope' not found.*default.*inbox_zero/s,
    );
  });
});

describe('applyProfileOverrides', () => {
  const baseConfig: CallsheetConfig = {
    model: 'claude-sonnet-4-20250514',
    connectors: {
      gmail: { enabled: true, query: 'newer_than:2d', max_messages: 25 },
      todoist: { enabled: true, accounts: [{ name: 'Alice', token_env: 'T' }] },
      weather: { enabled: true, location: 'Somewhere' },
    },
  };

  it('merges profile overrides on top of base connector config', () => {
    const merged = applyProfileOverrides(baseConfig, {
      connectors: { gmail: { query: 'in:inbox', max_messages: 200 } },
    });
    expect(merged.connectors?.gmail).toEqual({
      enabled: true,
      query: 'in:inbox', // overridden
      max_messages: 200, // overridden
    });
  });

  it('disables connectors not referenced by the profile', () => {
    const merged = applyProfileOverrides(baseConfig, {
      connectors: { gmail: {} },
    });
    expect(merged.connectors?.weather?.enabled).toBe(false);
    expect(merged.connectors?.todoist?.enabled).toBe(false);
    expect(merged.connectors?.gmail?.enabled).toBe(true);
  });

  it('does not mutate the caller config', () => {
    const beforeJson = JSON.stringify(baseConfig);
    applyProfileOverrides(baseConfig, { connectors: { gmail: { query: 'x' } } });
    expect(JSON.stringify(baseConfig)).toBe(beforeJson);
  });

  it('preserves non-connector config fields', () => {
    const merged = applyProfileOverrides(baseConfig, {
      connectors: { todoist: { include_overdue_only: true } },
    });
    expect(merged.model).toBe('claude-sonnet-4-20250514');
  });
});
