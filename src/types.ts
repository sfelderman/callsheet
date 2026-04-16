export interface ConnectorResult {
  source: string;
  description: string;
  data: Record<string, unknown>;
  priorityHint: 'high' | 'normal' | 'low';
}

export interface Connector {
  readonly name: string;
  readonly description: string;
  fetch(): Promise<ConnectorResult>;
}

export type ConnectorFactory = (config: ConnectorConfig) => Connector;

/** Diagnostic check result: [icon, message, detail]. */
export type Check = [icon: string, msg: string, detail: string];

/** Optional per-connector config validator for --test mode. */
export type ConnectorValidator = (config: ConnectorConfig) => Check[];

/** Optional per-connector auth handler for --auth mode. */
export type ConnectorAuth = (
  credsDir: string,
  config: ConnectorConfig,
  accountName?: string,
) => Promise<void>;

export interface ConnectorConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface BriefExtra {
  name: string;
  instruction: string;
}

export interface CallsheetConfig {
  model?: string;
  printer?: string;
  output_dir?: string;
  credentials_dir?: string;
  context?: Record<string, string>;
  connectors?: Record<string, ConnectorConfig>;
  extras?: BriefExtra[];
  auto_close_tasks?: boolean;
  /** Per-connector deadline in milliseconds. Defaults to 60_000 (60s). */
  connector_timeout_ms?: number;
  /**
   * Day of the week (name like "saturday" or number 0-6 where 0=Sunday) on
   * which the daily brief is prepended with a compact "Week in Review"
   * section — a short retrospective blurb reflecting on the past 7 days.
   * On this day the calendar connector's lookback is auto-bumped to 7 days
   * so the retrospective has past events to reference. The daily brief is
   * NOT replaced — the Week in Review is a small supplemental section at
   * the top. Omit to disable.
   */
  weekly_review_day?: string | number;
}

/** A task that Claude recommends closing based on resolution signals. */
export interface AutoCloseRecommendation {
  task_id: string;
  task_content: string;
  person: string;
  reason: string;
}

/** Brief structure that Claude outputs. */
export interface Brief {
  title: string;
  subtitle?: string;
  sections: BriefSection[];
}

export interface BriefSection {
  heading: string;
  items?: BriefItem[];
  body?: string;
}

export interface BriefItem {
  label: string;
  time?: string;
  note?: string;
  checkbox?: boolean;
  highlight?: boolean;
  urgent?: boolean;
}

// ---------------------------------------------------------------------------
// Triage — interactive inbox/task cleanup sessions (see docs/TRIAGE.md)
// ---------------------------------------------------------------------------

/**
 * Per-connector fetch overrides applied when running a triage session.
 * Deep-merged on top of `config.connectors.gmail` at run time so the daily
 * brief's narrow defaults (25 recent messages) don't constrain cleanup work.
 */
export interface GmailTriageOverrides {
  /** Gmail search query — replaces the base config query entirely. */
  query?: string;
  max_messages?: number;
  trash_max_age?: string;
  pinned_labels?: string[];
  /** Subset of configured account names to include. Omit for all. */
  accounts?: string[];
}

/**
 * Per-connector fetch overrides for Todoist during a triage session.
 * Post-fetch filters (overdue_only, older_than_days, projects) apply in
 * `connectors/todoist.ts` because the Todoist REST API doesn't support them.
 */
export interface TodoistTriageOverrides {
  /** Hard cap on total tasks returned (post-filter). */
  max_tasks?: number;
  include_overdue_only?: boolean;
  /** Only include tasks whose earliest-known timestamp is >= N days ago. */
  include_older_than_days?: number;
  /** Project names to include (exact match). Omit for all projects. */
  projects?: string[];
  accounts?: string[];
}

export interface TriageProfile {
  description?: string;
  connectors: {
    gmail?: GmailTriageOverrides;
    todoist?: TodoistTriageOverrides;
  };
}

export interface TriageProfilesFile {
  profiles: Record<string, TriageProfile>;
}

/** Discriminated verb the triage executor dispatches on. */
export type TriageVerb =
  | { kind: 'gmail_archive' }
  | { kind: 'gmail_mark_read' }
  | { kind: 'gmail_trash' }
  | { kind: 'gmail_keep' }
  | { kind: 'todoist_close' }
  | { kind: 'todoist_reschedule'; due_string: string }
  | { kind: 'todoist_keep' };

/** A single triage decision Claude proposes for an item. */
export interface TriageAction {
  /** Gmail message id or Todoist task id — used by executors to hit the API. */
  id: string;
  source: 'gmail' | 'todoist';
  /** Account name for multi-account connectors (resolves token / OAuth file). */
  account?: string;
  /** One-line human summary Claude writes for the interactive prompt. */
  item_summary: string;
  proposed_action: TriageVerb;
  /** One-sentence rationale shown beside the proposed action. */
  rationale: string;
  /** Sender email (gmail) or project name (todoist) for `[m]ore` drill-down. */
  drill_key?: string;
  /** Optional cross-service routing recommendation — surfaced as a second prompt. */
  routing_suggestion?: {
    target: 'todoist';
    payload: { content: string; project?: string; due_string?: string };
    reason: string;
  };
}

export interface TriageSession {
  summary: string;
  profile: string;
  actions: TriageAction[];
  /** ISO-8601 timestamp. */
  generated_at: string;
}
