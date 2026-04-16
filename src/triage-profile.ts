import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import type {
  TriageProfile,
  TriageProfilesFile,
  GmailTriageOverrides,
  TodoistTriageOverrides,
  CallsheetConfig,
  ConnectorConfig,
} from './types.js';

/**
 * Triage profiles (triage.yaml) are deliberately strict: the daily brief
 * config stays general-purpose, but triage sessions perform irreversible
 * writes (archive email, close tasks), so a typo in the profile shouldn't
 * quietly widen a fetch. The validator flags unknown keys, wrong types,
 * unknown connector references, and accounts that don't exist in the
 * caller's base config.
 *
 * This strictness is also deliberate so Claude can safely edit triage.yaml
 * on the user's behalf — failures are loud, messages are specific, and
 * typos surface as "did you mean X?" hints rather than mysterious runtime
 * behavior.
 */

// Keep these literal-typed so a future connector addition is forced to
// touch this module — the compiler will complain if we miss a branch.
const ALLOWED_GMAIL_KEYS = [
  'query',
  'max_messages',
  'trash_max_age',
  'pinned_labels',
  'accounts',
] as const satisfies readonly (keyof GmailTriageOverrides)[];

const ALLOWED_TODOIST_KEYS = [
  'max_tasks',
  'include_overdue_only',
  'include_older_than_days',
  'projects',
  'accounts',
] as const satisfies readonly (keyof TodoistTriageOverrides)[];

const ALLOWED_CONNECTORS = ['gmail', 'todoist'] as const;

export interface TriageProfileIssue {
  profile: string;
  path: string;
  message: string;
}

const DEFAULT_TRIAGE_FILE = 'triage.yaml';

/**
 * Cheap Levenshtein-ish suggestion helper — returns the closest key from
 * `candidates` if any is within 2 edits of `needle`, otherwise undefined.
 * Used in validator error messages so typos read as "did you mean X?".
 */
function didYouMean(needle: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const c of candidates) {
    const d = editDistance(needle, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array(n + 1)
    .fill(0)
    .map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1, // deletion
        dp[j - 1] + 1, // insertion
        prev + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
      prev = tmp;
    }
  }
  return dp[n];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateGmail(
  profileName: string,
  overrides: unknown,
  baseConfig: CallsheetConfig | undefined,
  issues: TriageProfileIssue[],
): void {
  if (!isPlainObject(overrides)) {
    issues.push({
      profile: profileName,
      path: 'connectors.gmail',
      message: 'Expected an object of gmail override keys.',
    });
    return;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!(ALLOWED_GMAIL_KEYS as readonly string[]).includes(key)) {
      const hint = didYouMean(key, ALLOWED_GMAIL_KEYS);
      issues.push({
        profile: profileName,
        path: `connectors.gmail.${key}`,
        message: `Unknown gmail override key '${key}'.${hint ? ` Did you mean '${hint}'?` : ''}`,
      });
      continue;
    }
    switch (key as keyof GmailTriageOverrides) {
      case 'query':
      case 'trash_max_age':
        if (typeof value !== 'string') {
          issues.push({
            profile: profileName,
            path: `connectors.gmail.${key}`,
            message: `Expected a string, got ${typeof value}.`,
          });
        }
        break;
      case 'max_messages':
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          issues.push({
            profile: profileName,
            path: `connectors.gmail.${key}`,
            message: `Expected a positive integer, got ${JSON.stringify(value)}.`,
          });
        }
        break;
      case 'pinned_labels':
      case 'accounts':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          issues.push({
            profile: profileName,
            path: `connectors.gmail.${key}`,
            message: `Expected an array of strings.`,
          });
        }
        break;
      default:
        // Unreachable: ALLOWED_GMAIL_KEYS is exhaustive.
        break;
    }
  }

  // Cross-check account names against base config so typos surface early.
  const declared = (overrides as GmailTriageOverrides).accounts;
  if (Array.isArray(declared) && baseConfig) {
    const configured = (
      (baseConfig.connectors?.gmail?.accounts as { name?: string }[] | undefined) ?? []
    )
      .map((a) => a?.name)
      .filter((n): n is string => typeof n === 'string');
    // A single-account gmail config has no `accounts` array — skip the check
    // in that case because the override doesn't apply anyway.
    if (configured.length) {
      for (const name of declared) {
        if (typeof name === 'string' && !configured.includes(name)) {
          issues.push({
            profile: profileName,
            path: `connectors.gmail.accounts`,
            message: `Account '${name}' is not configured in config.yaml connectors.gmail.accounts.`,
          });
        }
      }
    }
  }
}

function validateTodoist(
  profileName: string,
  overrides: unknown,
  baseConfig: CallsheetConfig | undefined,
  issues: TriageProfileIssue[],
): void {
  if (!isPlainObject(overrides)) {
    issues.push({
      profile: profileName,
      path: 'connectors.todoist',
      message: 'Expected an object of todoist override keys.',
    });
    return;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!(ALLOWED_TODOIST_KEYS as readonly string[]).includes(key)) {
      const hint = didYouMean(key, ALLOWED_TODOIST_KEYS);
      issues.push({
        profile: profileName,
        path: `connectors.todoist.${key}`,
        message: `Unknown todoist override key '${key}'.${hint ? ` Did you mean '${hint}'?` : ''}`,
      });
      continue;
    }
    switch (key as keyof TodoistTriageOverrides) {
      case 'max_tasks':
      case 'include_older_than_days':
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          issues.push({
            profile: profileName,
            path: `connectors.todoist.${key}`,
            message: `Expected a positive integer, got ${JSON.stringify(value)}.`,
          });
        }
        break;
      case 'include_overdue_only':
        if (typeof value !== 'boolean') {
          issues.push({
            profile: profileName,
            path: `connectors.todoist.${key}`,
            message: `Expected a boolean, got ${typeof value}.`,
          });
        }
        break;
      case 'projects':
      case 'accounts':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          issues.push({
            profile: profileName,
            path: `connectors.todoist.${key}`,
            message: `Expected an array of strings.`,
          });
        }
        break;
      default:
        // Unreachable: ALLOWED_TODOIST_KEYS is exhaustive.
        break;
    }
  }

  const declared = (overrides as TodoistTriageOverrides).accounts;
  if (Array.isArray(declared) && baseConfig) {
    const configured = (
      (baseConfig.connectors?.todoist?.accounts as { name?: string }[] | undefined) ?? []
    )
      .map((a) => a?.name)
      .filter((n): n is string => typeof n === 'string');
    if (configured.length) {
      for (const name of declared) {
        if (typeof name === 'string' && !configured.includes(name)) {
          issues.push({
            profile: profileName,
            path: `connectors.todoist.accounts`,
            message: `Account '${name}' is not configured in config.yaml connectors.todoist.accounts.`,
          });
        }
      }
    }
  }
}

function validateProfile(
  name: string,
  raw: unknown,
  baseConfig: CallsheetConfig | undefined,
  issues: TriageProfileIssue[],
): void {
  if (!isPlainObject(raw)) {
    issues.push({ profile: name, path: '', message: 'Profile must be an object.' });
    return;
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'description' && key !== 'connectors') {
      issues.push({
        profile: name,
        path: key,
        message: `Unknown profile key '${key}'. Allowed: 'description', 'connectors'.`,
      });
    }
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    issues.push({
      profile: name,
      path: 'description',
      message: `Expected a string, got ${typeof raw.description}.`,
    });
  }
  const { connectors } = raw;
  if (!isPlainObject(connectors)) {
    issues.push({
      profile: name,
      path: 'connectors',
      message: "Profile must have a 'connectors' object naming at least one of: gmail, todoist.",
    });
    return;
  }
  const hasAny = Object.keys(connectors).some((k) =>
    (ALLOWED_CONNECTORS as readonly string[]).includes(k),
  );
  if (!hasAny) {
    issues.push({
      profile: name,
      path: 'connectors',
      message: `Profile must reference at least one supported connector: ${ALLOWED_CONNECTORS.join(', ')}.`,
    });
  }
  for (const [connName, overrides] of Object.entries(connectors)) {
    if (!(ALLOWED_CONNECTORS as readonly string[]).includes(connName)) {
      const hint = didYouMean(connName, ALLOWED_CONNECTORS);
      issues.push({
        profile: name,
        path: `connectors.${connName}`,
        message: `Unsupported connector '${connName}' in triage profile.${hint ? ` Did you mean '${hint}'?` : ''}`,
      });
      continue;
    }
    if (connName === 'gmail') {
      validateGmail(name, overrides, baseConfig, issues);
    } else if (connName === 'todoist') {
      validateTodoist(name, overrides, baseConfig, issues);
    }
  }
}

/**
 * Validate a parsed triage.yaml payload. Returns a list of issues — empty
 * means the file is safe to use. Does not throw.
 */
export function validateTriageProfiles(
  raw: unknown,
  baseConfig?: CallsheetConfig,
): TriageProfileIssue[] {
  const issues: TriageProfileIssue[] = [];
  if (!isPlainObject(raw)) {
    issues.push({ profile: '<root>', path: '', message: 'Root must be an object.' });
    return issues;
  }
  const { profiles } = raw;
  if (!isPlainObject(profiles)) {
    issues.push({
      profile: '<root>',
      path: 'profiles',
      message: "Root must contain a 'profiles' object keyed by profile name.",
    });
    return issues;
  }
  if (Object.keys(profiles).length === 0) {
    issues.push({
      profile: '<root>',
      path: 'profiles',
      message: "No profiles defined. Add at least one entry under 'profiles:'.",
    });
    return issues;
  }
  for (const [name, profile] of Object.entries(profiles)) {
    validateProfile(name, profile, baseConfig, issues);
  }
  return issues;
}

/**
 * Load triage.yaml, validate, and return the typed payload.
 * Throws an aggregated error listing every issue so users (and Claude)
 * see the full picture in one go.
 */
export function loadTriageFile(
  path: string = DEFAULT_TRIAGE_FILE,
  baseConfig?: CallsheetConfig,
): TriageProfilesFile {
  if (!existsSync(path)) {
    throw new Error(
      `Triage profile file not found: ${path}\n` +
        `Copy triage.example.yaml to ${path} and edit it, or pass --triage-file <path>.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to parse ${path} as YAML: ${e instanceof Error ? e.message : e}`, {
      cause: e,
    });
  }
  const issues = validateTriageProfiles(parsed, baseConfig);
  if (issues.length) {
    const formatted = issues
      .map((i) => `  - [${i.profile}${i.path ? ':' + i.path : ''}] ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ${path}:\n${formatted}`);
  }
  return parsed as TriageProfilesFile;
}

/**
 * Resolve a named profile from a loaded triage file.
 * Throws a helpful error if the name is missing, including the list of
 * available profiles.
 */
export function resolveProfile(file: TriageProfilesFile, name: string): TriageProfile {
  const profile = file.profiles[name];
  if (!profile) {
    const available = Object.keys(file.profiles).sort().join(', ');
    throw new Error(
      `Triage profile '${name}' not found. Available profiles: ${available || '<none>'}.`,
    );
  }
  return profile;
}

/**
 * Apply a triage profile's per-connector overrides on top of the caller's
 * CallsheetConfig, returning a new config where:
 *  - Every connector referenced by the profile inherits its base config
 *    with the profile's keys merged on top (override wins).
 *  - Every connector NOT referenced by the profile is disabled, so
 *    fetchAll() will skip it. Triage sessions are always scoped.
 *
 * Never mutates the caller's config.
 */
export function applyProfileOverrides(
  baseConfig: CallsheetConfig,
  profile: TriageProfile,
): CallsheetConfig {
  const baseConnectors = baseConfig.connectors ?? {};
  const nextConnectors: Record<string, ConnectorConfig> = {};

  // Start by disabling every connector — triage only runs what the profile names.
  for (const [name, cfg] of Object.entries(baseConnectors)) {
    nextConnectors[name] = { ...cfg, enabled: false };
  }

  for (const [connName, overrides] of Object.entries(profile.connectors)) {
    if (!overrides) continue;
    const base = baseConnectors[connName] ?? {};
    nextConnectors[connName] = {
      ...base,
      ...overrides,
      enabled: true,
    };
  }

  return { ...baseConfig, connectors: nextConnectors };
}
