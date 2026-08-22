import { tzOffsetMs, zonedDayStart, todayYmd, shiftYmd, formatLongDate } from '../src/dates.js';

describe('tzOffsetMs', () => {
  it('returns a negative offset for US zones west of Greenwich', () => {
    // 2026-08-22 is inside CDT (UTC-5).
    expect(tzOffsetMs(new Date('2026-08-22T12:00:00Z'), 'America/Chicago')).toBe(-5 * 3_600_000);
  });

  it('tracks daylight saving transitions', () => {
    // CST (UTC-6) in January, CDT (UTC-5) in August.
    expect(tzOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/Chicago')).toBe(-6 * 3_600_000);
    expect(tzOffsetMs(new Date('2026-08-15T12:00:00Z'), 'America/Chicago')).toBe(-5 * 3_600_000);
  });

  it('returns zero for UTC', () => {
    expect(tzOffsetMs(new Date('2026-08-22T12:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('zonedDayStart', () => {
  it('resolves local midnight to the correct UTC instant', () => {
    // Midnight CDT on 2026-08-22 is 05:00 UTC the same day.
    expect(zonedDayStart('2026-08-22', 'America/Chicago').toISOString()).toBe(
      '2026-08-22T05:00:00.000Z',
    );
  });

  it('uses the winter offset for a winter date', () => {
    // Midnight CST on 2026-01-15 is 06:00 UTC.
    expect(zonedDayStart('2026-01-15', 'America/Chicago').toISOString()).toBe(
      '2026-01-15T06:00:00.000Z',
    );
  });

  it('handles the spring-forward day, where local midnight still exists', () => {
    // DST starts 2026-03-08 at 02:00 local; midnight is still CST (UTC-6).
    expect(zonedDayStart('2026-03-08', 'America/Chicago').toISOString()).toBe(
      '2026-03-08T06:00:00.000Z',
    );
  });

  it('is identity-like for UTC', () => {
    expect(zonedDayStart('2026-08-22', 'UTC').toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });

  it('works east of Greenwich', () => {
    // Midnight in Budapest (CEST, UTC+2) is 22:00 UTC the previous day.
    expect(zonedDayStart('2026-08-22', 'Europe/Budapest').toISOString()).toBe(
      '2026-08-21T22:00:00.000Z',
    );
  });
});

describe('todayYmd', () => {
  it('uses the local day, not the UTC day, late in the evening', () => {
    // 01:30 UTC on the 23rd is still 20:30 on the 22nd in Chicago.
    const late = new Date('2026-08-23T01:30:00Z');
    expect(todayYmd('America/Chicago', late)).toBe('2026-08-22');
    expect(todayYmd('UTC', late)).toBe('2026-08-23');
  });

  it('falls back to the TZ environment variable', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      expect(todayYmd(undefined, new Date('2026-08-23T01:30:00Z'))).toBe('2026-08-23');
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});

describe('shiftYmd', () => {
  it('shifts forward and backward', () => {
    expect(shiftYmd('2026-08-22', 1)).toBe('2026-08-23');
    expect(shiftYmd('2026-08-22', -7)).toBe('2026-08-15');
  });

  it('crosses month and year boundaries', () => {
    expect(shiftYmd('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftYmd('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles leap days', () => {
    expect(shiftYmd('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('formatLongDate', () => {
  it('renders the weekday and date that actually belong together', () => {
    // 2026-08-22 is a Saturday. Briefs previously paired this weekday with
    // the 23rd, which is a Sunday.
    expect(formatLongDate('2026-08-22')).toBe('Saturday, August 22, 2026');
  });

  it('is stable regardless of the process timezone', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(formatLongDate('2026-01-01')).toBe('Thursday, January 1, 2026');
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});
