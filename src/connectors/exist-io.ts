import type { Connector, ConnectorConfig, ConnectorResult, Check } from '../types.js';
import { PASS, FAIL, WARN, INFO } from '../test-icons.js';

const API = 'https://exist.io/api/2';
const DEFAULT_GROUPS = ['mood', 'custom'];
const MAX_DAYS = 31;

interface ExistGroup {
  name: string;
  label?: string;
  priority?: number;
}

interface ExistAttribute {
  name: string;
  label?: string;
  template?: string | null;
  group?: ExistGroup;
  value_type?: number;
  values?: { date: string; value: unknown }[];
}

interface ExistPage<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

interface ExistInsight {
  html?: string;
  text?: string;
  target_date?: string;
  priority?: number;
  type?: { name?: string } | string;
}

interface DayRecord {
  date: string;
  mood?: number;
  mood_note?: string;
  tags: string[];
  metrics: Record<string, unknown>;
}

function clampDays(raw: unknown): number {
  let n = NaN;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string') n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(Math.floor(n), MAX_DAYS);
}

function renderTagName(name: string): string {
  return name.replace(/_/g, ' ').trim();
}

async function fetchJson<T>(url: URL, token: string): Promise<T> {
  const resp = await fetch(url, {
    headers: { Authorization: `Token ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`exist.io ${url.pathname}: ${resp.status}`);
  return (await resp.json()) as T;
}

async function fetchAllPages<T>(firstUrl: URL, token: string): Promise<T[]> {
  const all: T[] = [];
  let nextUrl: string | null = firstUrl.toString();
  while (nextUrl) {
    const page: ExistPage<T> = await fetchJson<ExistPage<T>>(new URL(nextUrl), token);
    all.push(...page.results);
    nextUrl = page.next;
  }
  return all;
}

function pivotByDay(attributes: ExistAttribute[]): DayRecord[] {
  const byDate = new Map<string, DayRecord>();

  function ensure(date: string): DayRecord {
    let rec = byDate.get(date);
    if (!rec) {
      rec = { date, tags: [], metrics: {} };
      byDate.set(date, rec);
    }
    return rec;
  }

  for (const attr of attributes) {
    const values = attr.values ?? [];
    for (const v of values) {
      if (v.value === null || v.value === undefined) continue;
      const day = ensure(v.date);

      if (attr.name === 'mood_note') {
        if (typeof v.value === 'string') {
          const text = v.value.trim();
          if (text) day.mood_note = text;
        }
      } else if (attr.name === 'mood') {
        if (typeof v.value === 'number') day.mood = v.value;
      } else if (attr.group?.name === 'custom') {
        if (v.value === 1 || v.value === true) {
          day.tags.push(renderTagName(attr.name));
        }
      } else if (typeof v.value === 'number' || typeof v.value === 'string') {
        day.metrics[attr.name] = v.value;
      }
    }
  }

  const days = [...byDate.values()].filter(
    (d) =>
      d.mood !== undefined ||
      d.mood_note !== undefined ||
      d.tags.length > 0 ||
      Object.keys(d.metrics).length > 0,
  );
  days.sort((a, b) => b.date.localeCompare(a.date));
  for (const d of days) d.tags.sort();
  return days;
}

export function create(config: ConnectorConfig): Connector {
  return {
    name: 'exist_io',
    description: 'exist.io — daily journal, mood, tags, and tracked metrics',

    async fetch(): Promise<ConnectorResult> {
      const tokenEnv = (config.token_env as string) ?? 'EXIST_IO_TOKEN';
      const token = process.env[tokenEnv] ?? '';
      if (!token) throw new Error(`${tokenEnv} not set`);

      const days = clampDays(config.lookback_days);
      const attributes = (config.attributes as string[] | undefined)?.filter(Boolean) ?? [];
      const groups =
        attributes.length > 0
          ? []
          : ((config.groups as string[] | undefined)?.filter(Boolean) ?? DEFAULT_GROUPS);

      const url = new URL(`${API}/attributes/with-values/`);
      url.searchParams.set('days', String(days));
      url.searchParams.set('limit', '100');
      if (attributes.length) url.searchParams.set('attributes', attributes.join(','));
      if (groups.length) url.searchParams.set('groups', groups.join(','));

      const attrs = await fetchAllPages<ExistAttribute>(url, token);
      const dayRecords = pivotByDay(attrs);

      let insights: ExistInsight[] = [];
      if (config.include_insights) {
        const today = new Date();
        const from = new Date();
        from.setDate(today.getDate() - (days - 1));
        const iso = (d: Date): string => d.toISOString().slice(0, 10);
        const iurl = new URL(`${API}/insights/`);
        iurl.searchParams.set('date_min', iso(from));
        iurl.searchParams.set('date_max', iso(today));
        iurl.searchParams.set('limit', '100');
        try {
          insights = await fetchAllPages<ExistInsight>(iurl, token);
        } catch {
          // Insights are supplemental — don't fail the whole connector if they error.
        }
      }

      const journalCount = dayRecords.filter((d) => d.mood_note).length;
      const tagCount = new Set(dayRecords.flatMap((d) => d.tags)).size;

      const data: Record<string, unknown> = {
        lookback_days: days,
        days: dayRecords,
      };
      if (config.include_insights) {
        data.insights = insights.map((i) => ({
          date: i.target_date ?? '',
          priority: i.priority ?? null,
          text: (i.text ?? '').trim(),
        }));
      }

      return {
        source: 'exist_io',
        description:
          `exist.io personal analytics for the last ${days} day(s). ` +
          `${dayRecords.length} day(s) with data, ${journalCount} journal entr${journalCount === 1 ? 'y' : 'ies'}, ${tagCount} distinct tag(s). ` +
          "Each day has optional 'mood' (1-5), 'mood_note' (free-text journal the user wrote), " +
          "'tags' (booleans the user flipped on — their own labels for how the day went), " +
          "and 'metrics' (tracked numbers like steps, sleep). " +
          'Use recent journal entries and tags to ground observations in how the user actually felt — ' +
          'reference them when they illuminate something in today brief (e.g. mentioning a mood dip, a ' +
          'recurring tag, or a streak). Do NOT parrot or summarize the full history; surface only what ' +
          'is notable or contextually useful today. Skip entirely when nothing stands out.',
        data,
        priorityHint: 'normal',
      };
    },
  };
}

export function validate(config: ConnectorConfig): Check[] {
  const checks: Check[] = [];
  const tokenEnv = (config.token_env as string) ?? 'EXIST_IO_TOKEN';
  const token = process.env[tokenEnv] ?? '';
  if (token) {
    const masked = token.length > 12 ? token.slice(0, 6) + '...' + token.slice(-4) : '***';
    checks.push([PASS, `${tokenEnv} is set`, masked]);
  } else {
    checks.push([FAIL, `${tokenEnv} is NOT set`, 'Add it to .env']);
  }

  const rawDays = config.lookback_days;
  const days = clampDays(rawDays);
  if (typeof rawDays === 'number' && rawDays > MAX_DAYS) {
    checks.push([WARN, `lookback_days ${rawDays} exceeds API max — clamped to ${MAX_DAYS}`, '']);
  } else {
    checks.push([INFO, `lookback_days: ${days}`, '']);
  }

  const attributes = (config.attributes as string[] | undefined)?.filter(Boolean) ?? [];
  const groups = (config.groups as string[] | undefined)?.filter(Boolean) ?? [];
  if (attributes.length) {
    checks.push([INFO, `attributes: ${attributes.join(', ')}`, '']);
  } else if (groups.length) {
    checks.push([INFO, `groups: ${groups.join(', ')}`, '']);
  } else {
    checks.push([
      WARN,
      `No groups or attributes set — defaulting to: ${DEFAULT_GROUPS.join(', ')}`,
      '',
    ]);
  }

  if (config.include_insights) {
    checks.push([INFO, 'include_insights: true', '']);
  }

  return checks;
}
