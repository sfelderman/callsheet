# Plan: Connector Data Payload Cleanup

## Context

Running `yarn data` on 2026-04-01 produced a 48KB JSON payload that's sent to Claude. ~12% of it is low-signal noise that Claude doesn't need — redundant fields, implicit data, empty strings, and unescaped characters. This plan cleans up the three main connectors (Todoist, Gmail, Calendar) to produce a leaner payload, reducing token cost ~$0.002/day and improving Claude's ability to focus on actionable data.

---

## Files to Modify

- `src/connectors/todoist.ts`
- `src/connectors/gmail.ts`
- `src/connectors/google-calendar.ts`
- `test/connectors/todoist.test.ts`
- `test/connectors/gmail.test.ts` (or `test/connectors/index.test.ts`)
- `test/connectors/google-keep.test.ts` — not modified

---

## Changes

### 1. Todoist (`src/connectors/todoist.ts`)

**In `simplify()` (lines 102–113):**

a. **Drop `id` field** — Todoist IDs are 16-char opaque strings. Claude can't act on them. Remove from `simplify()` return object.

b. **Omit `description` when empty** — Currently always included as `""`. Change to only include when truthy: `...(task.description ? { description: task.description.slice(0, 200) } : {})`.

c. **Drop `dueDate`, keep only `dueString`** — Both carry the same info. `dueString` is human-readable and conveys recurrence ("every monday"). `dueDate` is machine-readable ISO — not needed since Claude writes prose. Omit `dueDate` and `dueString` when both are empty (no due date).

**In `recently_completed` section (lines 152–157):**

d. **Drop `id` field** — same rationale.

e. **Truncate `completed_at` to date** — Microsecond UTC timestamps add noise. Slice to `completed_at.slice(0, 10)` for ISO date (e.g. `"2026-04-01"`).

---

### 2. Gmail (`src/connectors/gmail.ts`)

**In label filtering (lines 59–71):**

a. **Drop `UNREAD` and `IMPORTANT` from individual email label arrays** — The query is `is:unread is:important in:inbox` so these are implicit on every message. Remove them from the per-email `labels` array. (The `resolved: true` emails from trash/archive don't have UNREAD from the query, so this is safe.)

**In `fetchAccount` return object (lines 145–150):**

b. **Drop `userLabels` array** — This is a full dump of all 69 Gmail labels in the account, most of which never appear on any email. It adds 1,277 chars of irrelevant data. Remove this field from the returned account object.

**In snippet handling (`fetchMessages`, around line 75):**

c. **Decode HTML entities** — Apply a simple HTML entity decode to `msg.data.snippet` before including it: replace `&amp;` → `&`, `&#39;` → `'`, `&lt;` → `<`, `&gt;` → `>`, `&quot;` → `"`. Use a small inline helper function.

d. **Strip zero-width / invisible characters from snippets** — Strip Unicode zero-width chars (`\u200c`, `\u200b`, `\u00a0`, etc.) that appear in newsletter emails, leaving only the first meaningful portion.

**In email object (line 73–80):**

e. **Omit `resolved: false`** — Default is unresolved; only include `resolved: true` when it applies. Change to conditional spread: `...(resolved ? { resolved: true } : {})`.

---

### 3. Google Calendar (`src/connectors/google-calendar.ts`)

**In `simplifyEvent()` (lines 44–57):**

a. **Omit `location` when empty** — Change from `location: e.location ?? ''` to `...(e.location ? { location: e.location } : {})`.

b. **Omit `description` when empty** — Same pattern: only include when the truncated result is non-empty.

c. **Strip Google auto-generated boilerplate from `description`** — Calendar descriptions that start with or contain `"To see detailed information for automatically created events"` should be treated as empty. Add a check: if `desc.includes('automatically created events')`, set to `''`.

---

## Testing

1. Run `yarn test` — existing tests should pass. Update any tests that assert on dropped fields (e.g., if any test asserts `id` or `dueDate` is present).
2. Run `yarn data` and verify the output JSON is smaller and cleaner.
3. Spot-check that Todoist tasks with recurrence still show `dueString`.
4. Spot-check that Gmail emails still show user-defined labels (e.g., `"Family"`, `"TRASH"`).
5. Run `yarn preview` to confirm Claude still generates a coherent brief with the reduced payload.

---

## Estimated Impact

| Change | Savings |
|---|---|
| Todoist: drop ids + empty desc + dueDate | ~1,500 chars |
| Gmail: drop userLabels | ~1,277 chars |
| Gmail: drop IMPORTANT/UNREAD per-email | ~600 chars |
| Gmail: snippet cleanup (entities + zero-width) | ~300 chars + quality |
| Gmail: omit `resolved: false` | ~100 chars |
| Calendar: omit empty fields + strip boilerplate | ~500 chars |
| **Total** | **~4,300 chars (~9% reduction)** |

---

## Implementation Order

1. Todoist changes (simplify + recently_completed) — run tests
2. Gmail changes (labels, userLabels, snippets, resolved) — run tests
3. Calendar changes (empty fields, boilerplate strip) — run tests
4. `yarn data` to verify output
5. `yarn preview` to confirm brief quality

Each connector change gets its own commit with changeset.