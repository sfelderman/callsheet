/**
 * Finding the airports a household actually uses.
 *
 * Weather stations were configured once and then left alone, so the brief kept
 * reporting conditions for fields nobody had flown from in months while the
 * calendar plainly said where the flying was happening. Reading the airport
 * off the calendar keeps the two in step without anyone maintaining a list.
 */

/**
 * US airport identifiers as they appear in event text.
 *
 * Two shapes cover almost everything: a four-letter ICAO beginning with K, and
 * the three-character FAA identifiers used by smaller fields, which always mix
 * letters and digits. Bare three-letter codes are deliberately excluded — too
 * many ordinary words look like one.
 */
const ICAO = /\b(K[A-Z]{3})\b/g;
const THREE_CHAR = /\b([A-Z0-9]{3})\b/g;

/**
 * Three-character tokens that mix letters and digits but aren't airports.
 * Times and ordinals are the ones that actually show up in calendar text.
 */
const NOT_AN_AIRPORT = /^\d(AM|PM|ST|ND|RD|TH)$/;

/** Map a place name (as written in an event) to the station that serves it. */
export interface AirportAlias {
  /** Case-insensitive substring matched against the event's location/summary. */
  match: string;
  /** The station identifier to request weather for. */
  station: string;
}

/**
 * Pull airport identifiers out of free text.
 *
 * Only returns identifiers written literally in the text; nothing is inferred
 * from place names here — that's what aliases are for.
 */
export function extractStationIds(text: string): string[] {
  if (!text) return [];
  const upper = text.toUpperCase();
  const found = new Set<string>();

  ICAO.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ICAO.exec(upper)) !== null) found.add(m[1]);

  THREE_CHAR.lastIndex = 0;
  while ((m = THREE_CHAR.exec(upper)) !== null) {
    const token = m[1];
    // Must mix letters and digits: all-letters is a word, all-digits a number.
    if (!/[A-Z]/.test(token) || !/[0-9]/.test(token)) continue;
    if (NOT_AN_AIRPORT.test(token)) continue;
    found.add(token);
  }

  return [...found];
}

/** Stations whose configured alias matches this text. */
export function resolveAliases(text: string, aliases: AirportAlias[]): string[] {
  if (!text) return [];
  const haystack = text.toLowerCase();
  return aliases
    .filter((a) => a.match && haystack.includes(a.match.toLowerCase()))
    .map((a) => a.station);
}

/**
 * Work out which stations today's and the coming week's events point at.
 *
 * `events` are simplified calendar events; only `summary` and `location` are
 * read. `activityPattern` narrows this to the events that actually imply
 * flying, so a dinner reservation on an airfield road doesn't pull in a
 * station. With no pattern configured, every event is considered.
 */
export function deriveStationsFromEvents(
  events: { summary?: string; location?: string }[],
  aliases: AirportAlias[] = [],
  activityPattern?: string,
): string[] {
  let matches: RegExp | null = null;
  if (activityPattern) {
    try {
      matches = new RegExp(activityPattern, 'i');
    } catch {
      matches = null; // a bad pattern shouldn't silence the whole feature
    }
  }

  const stations = new Set<string>();
  for (const ev of events) {
    const text = `${ev.summary ?? ''} ${ev.location ?? ''}`;
    if (matches && !matches.test(text)) continue;
    for (const s of extractStationIds(text)) stations.add(s);
    for (const s of resolveAliases(text, aliases)) stations.add(s);
  }
  return [...stations];
}
