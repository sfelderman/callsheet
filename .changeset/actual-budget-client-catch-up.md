---
'callsheet': patch
---

Fix the Actual Budget connector after a server upgrade left the client behind.

The sync server had moved several releases ahead of the `@actual-app/api`
package, so the downloaded budget carried database migrations the client did
not recognise and every run failed with "Database is out of sync with
migrations". The connector has been silently absent from the brief for weeks.
Pinning the client to the server's release line restores it.
