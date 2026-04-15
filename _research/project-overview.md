# Callsheet — Project Overview

## What It Is

Callsheet generates a daily household brief: aggregates data from multiple sources, sends everything to Claude, gets back a prioritized PDF. Run on-demand or on a schedule.

**Repo:** `~/projects/callsheet` (forked from gemivnet/callsheet)
**Branch:** `sf/trying-it-out`

## Stack

- TypeScript 5.8, Node ≥20, ESM
- Yarn 4 (Berry, node-modules linker) — use `yarn`, not `npm`
- React PDF for PDF rendering
- Express for web dashboard
- Jest + ts-jest with `--experimental-vm-modules`
- Claude API (Anthropic SDK) — separate from Claude Code credits

## Architecture

```
config.yaml + .env
    ↓
core.ts — loadConnectors() → fetchAll()
    ↓
[connector1.fetch(), connector2.fetch(), ...]
    ↓
buildDataPayload(results) → JSON string
    ↓
Claude API (claude-sonnet-4-6) → brief text
    ↓
save memory (7-day rolling)
    ↓
self-critique (claude-haiku-4-5)
    ↓
React PDF → output/callsheet_YYYY-MM-DD.pdf
```

### 4 API calls per brief
1. Main brief generation (`claude-sonnet-4-6`)
2. Memory save
3. Self-critique (`claude-haiku-4-5-20251001`)
4. Auto-close

**Cost:** ~$0.02/day with Sonnet

## Key Directories

```
src/
  connectors/       — data sources, each exports create() + validate()
  prompts/          — Claude system prompt
  core.ts           — orchestration
  cli.ts            — CLI entry point
  types.ts          — ConnectorResult, Connector, Check interfaces
  test-icons.ts     — PASS/FAIL/WARN/INFO terminal icons

test/connectors/    — Jest tests, mirror src/connectors/
scripts/            — shell scripts
secrets/            — Google OAuth credentials (gitignored)
output/             — generated PDFs (gitignored)
fonts/              — Inter font files for PDF
.changeset/         — pending changesets
_research/          — temp research/context docs (this folder)
```

## Connector Pattern

Every connector exports:
```typescript
export function create(config: ConnectorConfig): Connector
export function validate(config: ConnectorConfig): Check[]
// Google connectors also export:
export const authFromConfig: ConnectorAuth
```

`Connector` = `{ name: string; description: string; fetch(): Promise<ConnectorResult> }`

`ConnectorResult` = `{ source, description, data, priorityHint: 'high'|'normal'|'low' }`

`Check` = `[icon: string, msg: string, detail: string]` — used by `yarn test:connector`

### Multi-account support
Google connectors (Calendar, Gmail) support an `accounts:` array in config, each with its own OAuth token file.

### Registry
`src/connectors/index.ts` maps connector names → `{ factory, validate, auth?, authScopes?, authTokenPrefix?, authLabel? }`.

## Config System

- `config.yaml` — non-secret settings (gitignored)
- `.env` — secrets (API keys, tokens)
- `config.example.yaml` — template checked into git

## Commands

```bash
yarn preview          # generate brief, don't print
yarn start            # generate + print
yarn test             # Jest suite (needs 4GB heap)
yarn test:connector   # run validate() on all enabled connectors
yarn data             # show raw connector data as JSON
yarn auth:gcal        # Google Calendar OAuth flow
yarn auth:gmail       # Gmail OAuth flow
yarn chrome:debug     # launch Chrome with CDP (for Keep scraper)
yarn changeset        # create a changeset before committing src/ changes
```

## Commit Rules (from CLAUDE.md)

- Gitmoji prefixes required (`✨`, `🐛`, `🔧`, etc.)
- Every `src/` change needs a changeset (`yarn changeset`) before committing
- Semver: MAJOR=breaking, MINOR=new feature, PATCH=fix/refactor
- Commit each change immediately — don't batch
