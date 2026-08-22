---
'callsheet': minor
---

Make the brief accountable for the facts it states.

A new `household` config section lists everyone the brief is about, including
people who have no calendar, inbox or task list of their own. Previously the
only people the brief knew were the ones with connector accounts, so a member
without any was invisible and their events read as belonging to whoever's
calendar carried them.

The brief's date is now computed rather than written by the model, which had
been pairing the right weekday with the next day's date on roughly one brief in
six. A new top-level `timezone` setting anchors that date, the output
filenames, the connector query windows and the scheduler to one zone, instead
of filenames following UTC while the visible dates followed somewhere else.

The prompt gains two rules: counts must be read from the structured
per-person aggregates rather than tallied by hand, and airport or station
identifiers must be copied from the payload rather than recalled. The
self-critique gains a factual-accuracy category so a brief that reads well but
states a wrong number is caught. Memory extraction no longer truncates
mid-array — its output limit was too small, so most days' insights failed to
parse and were silently dropped — and it no longer records counts, which go
stale the day after they are written.
