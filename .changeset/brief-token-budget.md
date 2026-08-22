---
'callsheet': patch
---

Give the brief enough token budget for models that reason before answering.

Current models spend part of the response budget thinking, so the previous
ceiling was consumed before the brief itself was written and every run ended
in a truncated response.
