---
'callsheet': patch
---

Refresh the model lineup and fix the usage pricing table.

The shipped default was a model that has since been retired, and the setup
script, web wizard and setup guide all still offered it. They now offer the
current Sonnet and Opus.

The pricing table priced Opus at three times its actual rate and had no entry
for any current model, so an unrecognised model was silently billed at Sonnet
rates. Rates are corrected, current models are listed, and an unlisted model is
now estimated from its family with a note in the log rather than assumed.
