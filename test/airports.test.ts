import {
  extractStationIds,
  resolveAliases,
  deriveStationsFromEvents,
} from '../src/airports.js';

describe('extractStationIds', () => {
  it('finds ICAO identifiers', () => {
    expect(extractStationIds('Weather at KDEN looks fine')).toEqual(['KDEN']);
  });

  it('finds alphanumeric FAA identifiers used by smaller fields', () => {
    expect(extractStationIds('Lesson at 06C this morning').sort()).toEqual(['06C']);
    expect(extractStationIds('Based at C77')).toEqual(['C77']);
  });

  it('is case-insensitive', () => {
    expect(extractStationIds('flying out of kbjc')).toEqual(['KBJC']);
  });

  it('deduplicates repeated mentions', () => {
    expect(extractStationIds('KDEN to KDEN')).toEqual(['KDEN']);
  });

  it('ignores plain three-letter words that are not identifiers', () => {
    // Bare alpha triplets are excluded on purpose: too many words qualify.
    expect(extractStationIds('The car was red and the sun was out')).toEqual([]);
  });

  it('ignores times and ordinals that share the identifier shape', () => {
    expect(extractStationIds('Lesson at 6AM on the 2ND, done by 8PM')).toEqual([]);
  });

  it('ignores bare numbers', () => {
    expect(extractStationIds('Suite 905 at 123 Main')).toEqual([]);
  });

  it('returns nothing for empty input', () => {
    expect(extractStationIds('')).toEqual([]);
  });
});

describe('resolveAliases', () => {
  const aliases = [
    { match: 'Northfield Aviation', station: 'K123' },
    { match: 'lakeside club', station: '9Z9' },
  ];

  it('matches a configured place name case-insensitively', () => {
    expect(resolveAliases('Lesson at NORTHFIELD AVIATION, 1 Main St', aliases)).toEqual(['K123']);
    expect(resolveAliases('Dinner at the Lakeside Club', aliases)).toEqual(['9Z9']);
  });

  it('returns nothing when no alias matches', () => {
    expect(resolveAliases('Dentist appointment', aliases)).toEqual([]);
  });

  it('tolerates an alias with an empty match string', () => {
    expect(resolveAliases('anything', [{ match: '', station: 'KXXX' }])).toEqual([]);
  });
});

describe('deriveStationsFromEvents', () => {
  const events = [
    { summary: 'Flight lesson', location: 'Northfield Aviation, 1 Main St' },
    { summary: 'Solo practice at KDEN', location: '' },
    { summary: 'Dentist', location: '123 Elm St' },
  ];
  const aliases = [{ match: 'Northfield Aviation', station: 'K123' }];

  it('combines literal identifiers and alias matches', () => {
    expect(deriveStationsFromEvents(events, aliases).sort()).toEqual(['K123', 'KDEN']);
  });

  it('narrows to flying events when an activity pattern is given', () => {
    // The dentist's street address must not pull in a station, and neither
    // should any event that isn't about flying.
    expect(deriveStationsFromEvents(events, aliases, 'flight|solo').sort()).toEqual([
      'K123',
      'KDEN',
    ]);
    expect(deriveStationsFromEvents(events, aliases, 'lesson')).toEqual(['K123']);
  });

  it('ignores a malformed activity pattern rather than dropping the feature', () => {
    expect(deriveStationsFromEvents(events, aliases, '([unclosed').sort()).toEqual([
      'K123',
      'KDEN',
    ]);
  });

  it('returns nothing when no event mentions an airport', () => {
    expect(deriveStationsFromEvents([{ summary: 'Dentist', location: 'Elm St' }])).toEqual([]);
  });

  it('handles events with missing fields', () => {
    expect(deriveStationsFromEvents([{}, { summary: undefined, location: undefined }])).toEqual([]);
  });
});
