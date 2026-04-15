# Plan: Pre-Review Layer (`--prereview` flag)

## Context

The daily brief is generated from raw connector data with minimal preprocessing. Two problems:
1. Noise reaches Sonnet — verbose backlog, stale emails, redundant fields dilute focus
2. Sonnet has no knowledge of what's on the user's mind before generating the brief

The pre-review layer adds a step between `fetchAll()` and the Sonnet brief that:
- Runs a Haiku classification pass (reusing existing `triage.ts`)
- Prints a compact terminal digest of top signals
- Prompts the user for optional focus/context (enter to skip)
- Injects both the Haiku summary and user input into the Sonnet brief prompt
- Keeps actionable items visible in the terminal — separate from the PDF brief

Enabled via `--prereview` flag (off by default).

---

## Architecture

```
yarn start --prereview

fetchAll() → ConnectorResult[]
    ↓
[NEW] runPreReview()
    ↓ classifyForTriage() [reused from triage.ts]
    ↓ print terminal digest
    ↓ readline prompt for user context (enter to skip)
    ↓ returns { triageSummary: string, userContext: string }
    ↓
buildDataPayload() → JSON string
    ↓
Sonnet brief (with triageSummary + userContext injected)
    ↓
... (memory, self-critique, PDF — unchanged)
```

---

## Files

### New: `src/prereview.ts`

Exports one function:

```typescript
export async function runPreReview(
  results: ConnectorResult[],
  config: CallsheetConfig,
  anthropic: Anthropic
): Promise<PreReviewOutput>

interface PreReviewOutput {
  triageSummary: string;  // compact text summary for Sonnet injection
  userContext: string;    // what user typed (empty string if skipped)
}
```

**Steps inside `runPreReview()`:**

1. **Haiku classification** — call `classifyForTriage(results, config, anthropic)` from `triage.ts`. Reuse existing logic entirely.

2. **Print terminal digest** — render a compact version using TriageResult:
   ```
   ─── Pre-Review ─────────────────────────────────
   Todoist  14 due today · 25 backlog
   Gmail    27 unread → 3 respond · 2 act · 4 read
   Calendar Flight to Detroit 2:50pm (grape/travel)

   Action items:
     🔴 Reply to Eve — dinner invite (Thu Apr 30)
     🔴 Pay invoice — billing@example.com (due soon)
     🟡 Review Xbox codes — expire Dec 2025

   Patterns:
     • 5 LinkedIn recruiter emails — consider filter

   Add focus / context for today's brief? (enter to skip)
   > _
   ────────────────────────────────────────────────
   ```

3. **readline prompt** — use Node's built-in `readline` module. 10-second timeout that auto-skips if no input (for cron/scheduled runs):
   ```typescript
   const userContext = await promptWithTimeout('Add focus / context for today\'s brief? (enter to skip)\n> ', 10_000);
   ```

4. **Build `triageSummary`** — compact text derived from TriageResult for Sonnet injection:
   ```
   Pre-review triage (Haiku pass):
   - 3 items need response: [Eve dinner invite, invoice due, ...]
   - 2 items need action: [...]
   - Detected patterns: [5 LinkedIn recruiters]
   ```
   Keep it under ~500 tokens — don't dump the full TriageResult.

5. **Return** `{ triageSummary, userContext }`.

---

### Modified: `src/core.ts`

In `generateBrief()` (or equivalent orchestration function):

1. Accept `preReview?: boolean` in the options/config.

2. After `fetchAll()`, if `preReview` is true:
   ```typescript
   const preReviewOutput = await runPreReview(results, config, anthropic);
   ```

3. Pass `preReviewOutput` into `buildDataPayload()` or inject directly into the Sonnet system/user prompt:
   ```
   [CONTEXT FROM PRE-REVIEW]
   Haiku triage summary:
   <triageSummary>

   User focus for today:
   <userContext or "(none provided)">
   [END PRE-REVIEW CONTEXT]
   ```
   Inject this as a prefix to the user message (not the system prompt) so it's clearly scoped data.

---

### Modified: `src/cli.ts`

Add `--prereview` boolean option alongside existing `--triage`, `--preview`, etc.:

```typescript
.option('--prereview', 'Run Haiku pre-review pass before generating brief')
```

Pass through to `generateBrief()` options.

---

### New: `test/prereview.test.ts`

Tests:

1. **`runPreReview` calls `classifyForTriage`** with correct args
2. **Digest rendering** — given a TriageResult, verify terminal output contains expected sections
3. **`triageSummary` format** — verify compact summary is built correctly from TriageResult
4. **Timeout/skip behavior** — when readline times out, `userContext` is `""`
5. **Integration: prereview output injected into prompt** — mock `classifyForTriage`, verify the returned strings appear in the Sonnet call args

---

## Key Decisions

**Reuse `classifyForTriage` from `triage.ts`** — avoids a second Haiku prompt design and leverages the existing category system (respond/act/followup/read/archive/noise). The triage prompt already handles multi-connector data.

**Don't replace raw data to Sonnet** — inject pre-review summary *alongside* the raw payload, not instead of it. Sonnet still sees all connector data. Pre-review adds signal without risking loss of detail. (Can revisit after validating brief quality.)

**10-second readline timeout** — allows cron/automated runs to proceed without hanging. User gets a window during manual `yarn start` runs.

**Flag default: off** — `--prereview` must be explicit. Add to `yarn start:full` or a new `yarn preview:full` script once validated.

---

## Testing

```bash
yarn test test/prereview.test.ts    # unit tests
yarn start --prereview              # manual run, verify digest appears + prompt works
yarn start --prereview --no-pdf     # fast validation (if --no-pdf exists)
yarn triage                         # verify triage still works independently
```

---

## Estimated Cost Impact

| Step | Model | Est. tokens | Est. cost |
|---|---|---|---|
| Haiku classification pass | haiku-4-5 | ~10k in / 2k out | ~$0.003 |
| Sonnet brief (unchanged) | sonnet-4-6 | ~15k in / 3k out | ~$0.020 |
| **Total with prereview** | | | **~$0.023/run** |

~15% cost increase per run. Acceptable given improved brief quality and the interactive focus layer.

---

## Implementation Order

1. `src/prereview.ts` — new file, `runPreReview()` + helpers
2. `test/prereview.test.ts` — unit tests
3. `src/cli.ts` — add `--prereview` flag
4. `src/core.ts` — wire in `runPreReview()` when flag is set
5. Manual test with `yarn start --prereview`
6. `yarn changeset` + commit each src change

---

## Open Questions / Future

- After validating, could make `--prereview` the default behavior
- Could write the terminal digest to `output/prereview_YYYY-MM-DD.md` for the same date (reuses output dir pattern)
- Could explore *replacing* raw connector data with Haiku-compressed summary to reduce Sonnet tokens (requires A/B quality testing first)
