# Plan: Connector-Aware Triage Classification

**Project:** callsheet
**Status:** Implemented (2026-04-01)
**Files changed:** `src/triage.ts`, `test/triage.test.ts`

## Context

`yarn triage todoist` returned a useless pattern saying "this isn't email data." The previous `classifyForTriage()` used a hardcoded email prompt and email-specific `TriageItem` schema (`subject`, `from`, `date`). Haiku correctly recognized it had no emails to classify.

The fix: make the triage system connector-aware — each connector type gets its own Haiku prompt and category set, with a shared renderer.

---

## Approach: Per-connector classifier dispatch

`classifyForTriage()` detects which connectors are present in the results and dispatches to a connector-specific classification function for each. Results are merged into a single markdown file with a section per connector.

### Why separate calls per connector vs one multi-connector prompt?
- One prompt mixing email + task classification logic gets confusing for Haiku
- Separate prompts → tighter schemas → better classification quality
- Each call is cheap (Haiku), so 2 calls for gmail + todoist is fine (~$0.02 total)

---

## Key design principle: lean Haiku output

Haiku output tokens cost 5x input. The old design had Haiku write verbose reasoning strings — expensive and redundant since the original item data already has subject/from/content.

**New approach:** Haiku outputs only index-based classification. TypeScript renders the full markdown by joining classifications with original connector data.

```
Input to Haiku: numbered list of items  →  Output from Haiku: { index, category, urgency }[]
```

Example Haiku output (50 emails → ~300 output tokens vs ~3000 previously):
```json
{
  "classifications": [
    {"i": 0, "c": "respond", "u": "h"},
    {"i": 1, "c": "noise",   "u": "l"},
    {"i": 2, "c": "act",     "u": "m"}
  ],
  "patterns": [
    {"indices": [1, 5, 12], "tag": "linkedin-recruiters"}
  ]
}
```

TypeScript then renders the full display using the original item data — Haiku never re-outputs it.

---

## Schema

**Haiku response schema** (what Haiku outputs — minimal):

```typescript
interface HaikuClassification {
  i: number;          // index into the items array sent to Haiku
  c: string;          // category shortcode
  u: 'h' | 'm' | 'l'; // urgency: high/medium/low (abbreviated)
}

interface HaikuResponse {
  classifications: HaikuClassification[];
  patterns: { indices: number[]; tag: string }[];
}
```

**Rendered item** (what TypeScript builds for display):

```typescript
export interface TriageItem {
  label: string;     // email subject OR task content
  meta?: string;     // "from sender" OR "in Project"
  date?: string;     // email date OR task due date
  category: string;  // connector-specific category name
  urgency: 'high' | 'medium' | 'low';
}
```

**Per-connector config:**

```typescript
interface ConnectorTriageConfig {
  categoryOrder: string[];
  categoryLabel: Record<string, string>;
  buildPrompt: (contextBlock: string) => string;
  extractItems: (data: Record<string, unknown>) => { label: string; meta?: string; date?: string }[];
}
```

---

## Connector configs

### Gmail categories:
`respond` → `act` → `followup` → `read` → `archive` → `noise`

### Todoist categories:
`keep` → `reschedule` → `schedule` → `waiting` → `defer` → `drop`

| Category | Meaning |
|----------|---------|
| `keep` | Genuine MUST-DO — due date is correct |
| `reschedule` | Due date is a visibility hack — not actually urgent |
| `schedule` | Valid task that needs a due date |
| `waiting` | Blocked on someone else or external dependency |
| `defer` | Fine in backlog, no date needed yet |
| `drop` | No longer relevant, stale, or superseded |

Todoist `extractItems()` includes all 4 buckets (today, upcoming, inbox, backlog). Items are tagged with their source bucket as context so Haiku knows whether a date was assigned.

---

## Markdown output format

```markdown
# Triage — 2026-04-01

**Sources:** gmail, todoist

---

## Gmail — 3 respond · 2 act · 8 noise

### Respond (3)
...

---

## Todoist — 2 keep · 5 schedule · 3 drop

### Keep (2)
...
```

---

## Future: Phase 2 cross-connector synthesis (not this plan)

A follow-on **Sonnet synthesis pass** would read all connector outputs together and find cross-source connections:
- "Gmail has a Hawaii trip confirmation May 5-10; Todoist has 'Book hotel for Hawaii' due May 1 → this is a REAL upcoming task, don't reschedule it"
- "You have 8 tasks due today but only 2 are genuine MUST-DOs based on context"

This would be a second API call after the individual Haiku passes, with the combined triage results + full connector data. Sonnet (not Haiku) for this since it requires reasoning across sources.
