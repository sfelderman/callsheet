# Triage

The daily brief is a read-only analyst view: it describes what's on your
plate. **Triage** is the complementary mode — a manually-triggered
interactive pass that walks a scoped slice of your Gmail and Todoist with
you and cleans it up. v1 supports Gmail (archive / mark read / trash / keep)
and Todoist (close / reschedule / keep).

## One-time setup

1. **Expand Gmail OAuth scope.** The daily brief used `gmail.readonly`;
   triage needs `gmail.modify` to archive / trash / mark-read. Re-run the
   OAuth flow once per Gmail account:

   ```bash
   callsheet --auth gmail
   # or for a named multi-account:
   callsheet --auth gmail:Primary
   ```

2. **Create `triage.yaml`.** Copy the shipped example and edit freely:

   ```bash
   cp triage.example.yaml triage.yaml
   ```

   `triage.yaml` is gitignored and user-owned (same idiom as `config.yaml`).

## Running a session

```bash
callsheet --triage                    # use the "default" profile
callsheet --triage inbox_zero         # use a named profile
callsheet --triage --triage-file custom.yaml inbox_zero
callsheet --list-triage-profiles      # list available profiles
callsheet --validate-triage-profiles  # validate triage.yaml and exit
```

Each session opens with Claude's state-of-the-world summary, then walks you
through every item with a proposed verb and a rationale. For each item:

| Key | Meaning |
|---|---|
| `y` | Execute the proposed action immediately. |
| `n` / `s` | Skip this item (no action taken). |
| `e` | Edit the action. v1 only supports editing `todoist_reschedule`'s `due_string`. |
| `m` | Drill down into this sender (Gmail) or project (Todoist) — runs a nested triage pass over the narrower slice, then returns to the main queue. |
| `q` | Quit the session immediately. Outcomes so far are saved. |

After each approved action, if Claude attached a `routing_suggestion`
(e.g., "this email should really be a Todoist task"), it's shown as a
second prompt for informational purposes. **v1 does not auto-create the
suggested task** — the user reviews and copies it manually. Auto-execution
of routing suggestions is planned for a later iteration.

## Profiles

A profile is a per-session fetch override. The connectors tuned for the
daily brief are far too narrow for cleanup — 25 recent emails is fine for a
summary, but inbox zero needs 500. Each profile defines filters per
connector; anything not referenced is disabled for the session.

Example `triage.yaml`:

```yaml
profiles:
  default:
    description: "Weekly cleanup pass"
    connectors:
      gmail:
        query: "newer_than:7d -category:promotions"
        max_messages: 150
      todoist:
        include_overdue_only: true
        max_tasks: 200

  inbox_zero:
    description: "Full inbox triage"
    connectors:
      gmail:
        query: "in:inbox"
        max_messages: 500
        accounts: ["Primary"]       # restrict to a subset of configured accounts

  stale_tasks:
    description: "Todoist tasks older than 30d"
    connectors:
      todoist:
        include_older_than_days: 30
        max_tasks: 300
```

### Available keys

**gmail**
- `query` — any Gmail search query (same syntax as the Gmail UI).
- `max_messages` — cap per fetch.
- `trash_max_age` — Gmail search for the "was auto-trashed" backfill.
- `pinned_labels` — skip messages carrying any of these labels.
- `accounts` — restrict to named accounts (subset of `config.yaml`'s
  `connectors.gmail.accounts`).

**todoist**
- `max_tasks` — cap per fetch.
- `include_overdue_only` — only tasks whose `due.date < today`.
- `include_older_than_days` — only tasks created more than N days ago.
- `projects` — restrict to named projects.
- `accounts` — restrict to named accounts.

### Validation

`triage.yaml` is strictly validated on load. Unknown keys, wrong types, or
references to undeclared accounts fail fast with helpful messages (and
"did you mean?" hints for common typos). This strictness is deliberate:
the loader is designed so Claude can safely pair-edit `triage.yaml` with
you, and a bad edit should fail loudly rather than producing confusing
runtime behavior.

Run `callsheet --validate-triage-profiles` to check without running a
session.

## Output

Every session writes a log to `output/triage/triage_<ISO>.json` with:
- the full session (summary, profile, actions)
- per-action outcomes (executed / skipped / failed, plus any error)

Mirrors `output/feedback/` and `output/auto_close/`.

## Conservatism

Triage executes against your real mailbox and task list. The prompt tells
Claude to default to `*_keep` when unsure — closing a task you still need
or trashing an email you wanted is worse than doing nothing. You can
always override; you can't easily un-delete. If a verb seems too
aggressive, press `n`.

## Future direction

- **Pre-approved rules** — graduating recurring decisions ("always archive
  marketing from X") out of the interactive pass.
- **Claude-driven drill-down** — tool use so the model can narrow scope
  mid-session rather than waiting for `[m]ore`.
- **Auto-execute routing suggestions** after approval.
- **Google Calendar invite triage** (`calendar.events` scope).
- **Web dashboard UI** — `src/triage.ts` is intentionally headless so a
  dashboard can wrap the same core.
