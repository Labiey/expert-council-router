# Backlog

Release cadence for this project is deliberately slow: a version is cut when there is a **measured**
defect or a requested feature, not a suspicion. Improvement ideas live here instead of becoming a
patch release, because between 0.8.5 and 0.8.7 five separate "known defects" were raised and then
knocked down by measurement - each one cost a release window and your attention.

An item moves out of this file only by being reproduced or requested. Items are not defects until
something demonstrates they are.

## Needs reproduction conditions

- **Does the observer window fold into a tab when the agent itself runs inside Windows Terminal?**
  `buildWindowPlan` now passes the reserved `-w new` id, which removes the question for hosts that do
  hit it - but the old behaviour was never reproduced, because this machine's Pi process is not
  inside a Windows Terminal session (no `WT_SESSION`), and `wt new-tab` opened a separate top-level
  window in both the old and the new form. Verifying the original claim requires running Pi inside
  Windows Terminal and comparing `wt new-tab …` with `wt -w new new-tab …` using top-level window
  enumeration as the discriminator (Windows Terminal is a single-process host, so the two windows
  share a pid and the runs must use distinct titles or the comparison reports a false negative).
- **`transcript+args` has never been exercised end to end against a live model.** The dial, the
  redaction default and the `$ command` header are covered by unit tests and by a synthetic stream,
  but no real delegation has been recorded at that level and then inspected, so the interaction
  between full argument capture and the byte ceilings is unmeasured.

## Needs a decision, not code

- **`recordReasoning` is global while the content dials are per-role.** Turning it on records
  reasoning for every role whose dial already records assistant text, which is a wider reach than
  "the debugger thinks out loud" and narrower than "record everything". If per-role reasoning is
  wanted it should be a sixth dial value rather than a second boolean, because the two switches can
  otherwise disagree in ways an operator has to reason about at 1am.

## Explicitly not planned for v1

Graphical UI, hosted control plane, recursive agent trees, learned routing weights, marketplace
crawling, remote analytics, and any automatic installation of third-party executable extensions.
