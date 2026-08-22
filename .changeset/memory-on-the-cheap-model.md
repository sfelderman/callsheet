---
'callsheet': patch
---

Run memory extraction on the cheap model.

It was using whichever model writes the brief, and since it is sent the same
full payload, it cost roughly as much per day as the brief itself. Summarising
data that has already been read is what the small model is for.
