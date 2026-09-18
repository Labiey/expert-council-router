# Backlog

Release cadence for this project is deliberately slow: a version is cut when there is a **measured**
defect or a requested feature, not a suspicion. Improvement ideas live here instead of becoming a
patch release, because between 0.8.5 and 0.8.7 five separate "known defects" were raised and then
knocked down by measurement - each one cost a release window and your attention.

An item moves out of this file only by being reproduced or requested. Items are not defects until
something demonstrates they are.

## Fixed on `main`, awaiting the next release

Found by reading real state during live delegations rather than by suspicion. Each one has a test.

- **The observer window expired while its delegation was still running.** The lifetime rule scaled a
  single attempt's `timeoutMs` by 1.5x, but a delegation may spend `retry.maxAttempts` attempts: a
  25-minute worker allowed three of them can run 75 minutes against a 37.5-minute window. The window
  now covers the whole delegation plus 1.25x for the work between attempts, and the follower's
  `--timeout-ms` ceiling rose from one hour to six so the correct budget is actually expressible.
- **`watch` reported a stale attempt outcome as the reason it stopped.** Given a per-attempt `failed`
  on disk, a follow timeout printed `stream closed (failed)` over a delegation still streaming on its
  third attempt. It now says the follow window expired and names the last attempt-level event as such.
- **`attention` events carried no identity.** The runtime wrote the warning text but not the code, so
  a budget warning, a tool-failure warning and a tool-silence warning were indistinguishable to
  anything reading the stream. The code is now written and survives the follower's frame whitelist.
- **No signal for "thinking, not executing."** An expert that reasons for minutes makes no tool errors,
  so every failure counter stayed quiet and the host could not tell that apart from a hang. One
  `tool_silence` warning now fires per attempt at 40% of its budget if no tool call was observed.
- **The `started` event could not say how hard the model was asked to think.** `reasoningLevel` is now
  recorded and forwarded, so a long quiet window can be read as high effort instead of a stall.

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

## Open limitations

- **`expert_status` and `expert_result` see only the executions of their own process.** A delegation
  started in one Pi session cannot be inspected, answered or aborted from another - observed directly:
  a running expert's `request_decision` was visible in its stream file and blocked, while every other
  session reported `"running": []`. The files under `observability/` are the only cross-session view,
  and `watch --json` is the only way to read a question you cannot answer from where you are sitting.
  Making the execution registry shared (or routing interactions to whichever session holds them) is
  unstarted work.

## Explicitly not planned for v1

Graphical UI, hosted control plane, recursive agent trees, learned routing weights, marketplace
crawling, remote analytics, and any automatic installation of third-party executable extensions.
