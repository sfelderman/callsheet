---
"callsheet": minor
---

Expand the Gmail connector's OAuth scope from `gmail.readonly` to
`gmail.modify` so the upcoming triage system can archive, mark read,
and trash messages on the user's approval. Existing users must re-run
`callsheet --auth gmail` after upgrading — the token issued under the
old readonly scope returns 403 on modify calls.

Also adds `src/connectors/gmail-mutate.ts` with `getGmailClient()`,
`archiveMessage()`, `markMessageRead()`, and `trashMessage()` — the
write-side primitives the triage executor dispatches to. Daily brief
behavior is unchanged; the wider scope is requested so one re-auth
covers both read and triage flows.
