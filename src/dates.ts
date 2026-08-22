/**
 * Timezone-aware date helpers.
 *
 * Everything user-facing in a brief is anchored to the household's local
 * wall-clock day, not UTC. Mixing the two is how a brief ends up filed under
 * one date while claiming another: the scheduler already worked in the
 * configured zone, but output filenames and window boundaries used
 * `toISOString()` / `Date.setHours()`, which follow UTC and the process
 * timezone respectively. These helpers give every caller one definition of
 * "today" and one way to bound a local day.
 */

/**
 * Milliseconds to add to a UTC instant to get the same wall-clock reading in
 * `tz`. Positive east of Greenwich. Derived from `Intl` rather than a table so
 * DST is handled by the platform's tzdata.
 */
export function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const f: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') f[p.type] = Number(p.value);
  }
  // `hour` comes back as 24 for midnight under hour12:false in some engines.
  const asIfUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour % 24, f.minute, f.second);
  return asIfUtc - date.getTime();
}

/**
 * The instant at which the local day `ymd` begins in `tz`.
 *
 * Resolved in two passes: guess midnight UTC, correct by that instant's
 * offset, then re-check. The second pass matters on DST boundaries, where the
 * offset at midnight UTC differs from the offset at local midnight.
 */
export function zonedDayStart(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  let instant = guess - tzOffsetMs(new Date(guess), tz);
  instant = guess - tzOffsetMs(new Date(instant), tz);
  return new Date(instant);
}

/** Today's date as YYYY-MM-DD in `tz` (defaults to TZ env, then system zone). */
export function todayYmd(tz?: string, now: Date = new Date()): string {
  const zone = tz ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Shift a YYYY-MM-DD by whole days. Calendar arithmetic, no timezone involved. */
export function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** Long-form date for a brief heading, e.g. "Saturday, August 22, 2026". */
export function formatLongDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
