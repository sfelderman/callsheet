# Google Keep — Two-Phase Integration Plan

## Why Two Phases

gkeepapi's Android OAuth flow is blocked by Google for personal accounts — `BadAuthentication` regardless of app password or account password. The `googleapis` Keep API is enterprise-only. The only viable path is browser-based scraping via Playwright CDP.

Rather than adding Playwright as a callsheet dependency, the approach splits into:
1. A standalone scraper POC (external project) that writes JSON to a file
2. A simple callsheet connector that reads that file

---

## Phase 1 — Keep Scraper POC

**Lives in:** `~/projects/playwright-browser-controller`

### How it works

```
Chrome running with --remote-debugging-port=9222
  ↓ chromium.connectOverCDP('http://localhost:9222')
Playwright (playwright-core, no bundled browser)
  ↓ opens new tab → navigates to keep.google.com
  ↓ page.evaluate(extractNotesFromDOM)
  ↓ closes tab (NOT browser)
~/.local/share/callsheet/keep-data.json
```

No auth needed — uses Chrome's existing Google session.

### Output JSON format

```json
{
  "scraped_at": "2026-03-31T10:00:00Z",
  "notes": [
    {
      "id": "keep-0",
      "title": "Shopping",
      "type": "LIST",
      "items": [{ "text": "Milk", "checked": false }, { "text": "Eggs", "checked": true }],
      "text": null,
      "labels": ["Household"],
      "pinned": true,
      "archived": false,
      "trashed": false,
      "color": "DEFAULT",
      "updated": null
    }
  ],
  "total_notes": 42
}
```

### Key files to create in playwright-browser-controller

1. **`scripts/launch-chrome-debug.sh`**
   - Starts Chrome with `--remote-debugging-port=9222`
   - **No `--user-data-dir`** — uses default profile (already logged in)
   - Idempotent: checks if CDP already running before launching
   - User must quit Chrome first if currently running without the flag

2. **`local-service/keep-scraper.ts`**
   - `chromium.connectOverCDP(CDP_URL)` → attach to Chrome
   - `browser.contexts()[0].newPage()` → open new tab
   - `page.goto('https://keep.google.com', { waitUntil: 'networkidle' })`
   - Check URL for login redirect (accounts.google.com → throw clear error)
   - `page.waitForSelector('[role="main"]', { timeout: 10_000 })`
   - `page.evaluate(extractNotesFromDOM)` → array of KeepNote
   - Write JSON to `~/.local/share/callsheet/keep-data.json`
   - `page.close()` in finally (never `browser.close()`)

3. **DOM extraction function** (`extractNotesFromDOM`)
   - Runs inside browser context via `page.evaluate()`
   - Uses stable ARIA attributes (more durable than obfuscated class names):
     - `[role="main"]` — content area
     - `[role="listitem"]` — note cards
     - `[role="checkbox"]` + `aria-checked` — list items
     - `contenteditable="true"` — title/body text
   - **Will need iteration** after first live test — selectors are best-guess

### How to run

```bash
# 1. Quit Chrome
# 2. Launch with CDP:
npm run chrome:debug
# 3. Use Chrome normally (keep.google.com loads your notes)
# 4. Scrape:
npm run scrape:keep
# Output: ~/.local/share/callsheet/keep-data.json
```

### Dependency

```bash
cd local-service && npm install playwright-core
```

### Known risks

- **DOM selectors break** when Google deploys Keep UI changes. Design the extraction function in isolation so it's easy to patch.
- **Dynamic loading** — Keep lazily loads notes on scroll. Initial scrape only gets what's visible. May need to scroll programmatically for full note list.
- **Chrome must have debug port** — if Chrome is running without it, must quit and relaunch.

---

## Phase 2 — Callsheet File-Reader Connector

**Do this after Phase 1 produces valid JSON.**

### What changes in callsheet

`src/connectors/google-keep.ts` — rewrite from Python subprocess to simple file reader:

```typescript
// fetch():
const raw = readFileSync(dataFile, 'utf8');
const data = JSON.parse(raw);
// check freshness, filter by titles, limit max_notes
// return ConnectorResult
```

No Playwright, no Python, no auth. Just reads a file.

### New config

```yaml
google_keep:
  enabled: true
  data_file: "~/.local/share/callsheet/keep-data.json"
  titles: []           # filter to specific note titles
  max_notes: 20
  max_age_hours: 24    # warn if data is stale
```

### validate() checks

- PASS/FAIL: `data_file` exists
- WARN: data older than `max_age_hours`
- INFO: titles, max_notes config

### Tests

Rewrite `test/connectors/google-keep.test.ts`:
- Mock `node:fs` (readFileSync, existsSync) — same pattern as other connectors
- No need to mock child_process or playwright

---

## Current State of google-keep.ts (as of 2026-03-31)

The connector exists but uses the dead Python/gkeepapi approach. It's registered in `index.ts` and has passing tests (mocked), but `fetch()` fails in production due to Google auth rejection.

Files to rewrite when starting Phase 2:
- `src/connectors/google-keep.ts`
- `test/connectors/google-keep.test.ts`
- `config.example.yaml` (google_keep section)
- `config.yaml` (personal config)
- Delete: `scripts/keep_fetch.py`, `.venv/`
- Remove: `GOOGLE_KEEP_APP_PASSWORD` from `.env`
