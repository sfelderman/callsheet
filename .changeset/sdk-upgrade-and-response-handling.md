---
'callsheet': patch
---

Upgrade the Anthropic SDK and stop mishandling unusual responses.

The SDK was around eighteen months behind. Reading the response text assumed
the first content block is always text and ignored `stop_reason` entirely, so
a truncated or declined response surfaced as a JSON parse error — or, for the
brief itself, as a generic "generation failed" page that said nothing about
what actually went wrong. Text is now collected from all text blocks, and
truncation and refusals are reported as themselves.

The brief's output limit is also raised, since the previous ceiling was close
enough to a long day's output to truncate it.
