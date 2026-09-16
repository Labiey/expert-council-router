# Changelog

All notable changes to Expert Council are documented here. Versions follow semantic versioning: major releases contain breaking changes, minor releases add backward-compatible functionality, and patch releases contain backward-compatible fixes.

## 0.8.6 - 2026-09-16

### Fixed
- **The expert window no longer closes in the middle of a delegation (defect #17).** Found live, during the
  first cross-process demo: a scout's first attempt died on a provider fault, the council escalated to another
  model and finished successfully, and `expert-council watch --follow` had already printed
  `stream closed (failed)` and exited - the operator saw the failure and never saw the work that answered.
  Each attempt had been writing its own terminal event, and the watcher treated any terminal event as the end
  of the stream. The council now writes one delegation-level `delegation_final` marker when a delegation is
  really over, and `watch` closes on that; a stream without the marker (an older runtime, or a process that
  died) closes after 750ms without growth, and `--timeout-ms` still bounds every wait. Verified by
  falsification: restoring the old rule reddens three watch tests, including the escalation case.
- **A struggling first attempt stopped vanishing when a retry succeeded (defect #20).** The delivered
  `executionMetadata` carried whatever the runtime's *last* attempt saw, so a delegation whose first attempt
  burned its budget on repeated tool failures reported no warnings at all once attempt two ran cleanly - and
  telemetry mixed an accumulated `toolErrors` with a single-attempt `toolCalls`. The council now folds
  delegation-wide totals: `toolCalls`, `toolErrors`, and `attention` deduplicated across attempts (last 8).
- **A struggle warning reached the operator's terminal with its sentence thrown away (defect #21).**
  `formatExpertEvent` had no `attention` case, so it fell through to the default branch and printed the bare
  kind name - observed live, two `attention` lines explained nothing. It renders
  `WARNING: <detail> (budget 60%, tool errors 1/2, expert steered)` now.
- **Guardrail counters never made it onto the stream, and would have been dropped if they had (defect #22).**
  The runtime wrote only the warning text, and the CLI's frame reader copies only fields it knows, so
  counters were lost at both ends of the same pipe. Both ends were fixed together and tested separately,
  because "the field exists" and "the field survives the projection" are different bugs - the same lesson as
  `interactionRounds` in 0.8.4 and `attempt` in 0.8.6.
- **An unreadable workspace diff no longer pretends to be a clean tree (defect #28).**
  `WorkspaceBoundary.changedFiles` swallowed its own `git status` failure and returned `[]`, so a mutation
  expert whose diff could not be read - the `$GIT_DIR` too big class from defect #11 is exactly this - was
  reported as an expert that changed nothing, and a host integrating from `filesChanged` integrated nothing
  at all. "Cannot tell" is now its own answer: `executionMetadata.filesChangedError` plus a risk line on
  every delivered path that gathers files (success, timeout, session error, thrown error, abort, expert
  stop). Swept the whole repository for this family: 70 `catch` blocks, 15 with no statement in the body,
  and every one of them read - the rest are deliberate (optional Pi capability probes, raced deletions,
  notices a host refused, teardown), and their reasons are now recorded next to the code.
- **A notice counter that counted attempts as deliveries (defect #29).** `watchForInteractions` incremented
  `sent` before calling the host, so when the host rejected every notice the watcher still reported one
  delivered - and the test asserted exactly that lie. It counts accepted notices now, matching the
  guardrail counter's ordering, and the test was strengthened rather than loosened: it also pins that a
  rejecting host is asked exactly once, since the dedupe key is consumed even when the send fails.
- **The test suite was never type-checked (defect #24).** The root tsconfig is a solution-style project -
  `"files": []` plus package references - so `npm run typecheck` only ever looked at `packages/*`. Every
  type-level guard written inside a test was therefore decorative, including two added that same day:
  `Record<keyof ExpertOutcome, ...>` and the `EVENT_KIND_COVERAGE` Record. `tsconfig.tests.json` now extends
  `tsconfig.base.json` - deliberately, so the suite faces the project's real strictness
  (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`) rather than a softer copy that under-reported by
  eight errors - and `typecheck` runs both halves. All 59 reported errors were fixture-level and are fixed.
- **A green test was not testing anything (defect #25).** `does not mark transient provider failures such as
  rate limits` asserted the opposite of the shipped contract, and passed only because its persistence stub
  referenced `current` - a type-annotation name, not a runtime binding - so it threw `ReferenceError` on
  every call into the best-effort `catch` in `service.ts`, which left nothing recorded. Rate limits DO mark,
  on purpose: on the 2-minute `MODEL_RATE_LIMIT_MARKER_TTL_MS` window rather than the blackout window, with
  provider siblings included, which is what the repo's rate-limit fix depends on. The test now pins that
  real contract, its fixture reports its own errors so a broken stub can never satisfy an assertion again,
  and expiry is proven through the imported constants. Non-vacuity was demonstrated in both directions:
  suppressing rate-limit evidence fails the marker assertions, and throttling on the blackout TTL fails the
  expiry assertions.
- **Best-effort persistence is no longer invisible (defect #26).** The silent `catch` was the enabling
  condition for #25. A marker that could not be written means the next delegation repeats a failure this one
  already learned about, so it is now recorded as `executionMetadata.persistenceErrors` and surfaced as a
  risk line - while still never aborting a delegation, which was the point of the catch.
- **`routePolicy` was read as optional although the type requires it (defect #27).** Five `?.` chains in
  `presentResourceInventory` implied a null case `ResourceInventory` has never allowed; nothing in the repo
  casts around that requirement, so the view reads it directly now.
- **The quiet-period fallback mistook an expert's silence for a dead stream (defect #23).** Seen live on the
  first run of the fixed window: a three-attempt delegation wrote its `delegation_final` marker on time, and
  the follower had already left 13 seconds earlier because 750ms had passed with nothing appended - an
  ordinary pause while a model thinks or a build runs. The fallback is 15s by default and tunable with
  `--quiet-ms`; the marker, or the operator's own `--timeout-ms`, remains the real signal.
- **`watch` reported the wrong outcome when it closed (defect #19).** A delegation that failed once and then
  succeeded announced itself as `stream closed (failed)`, because the watcher kept the first terminal event it
  had seen. It now keeps the last one, and a close driven by the delegation-level marker says
  `stream closed (delegation finished)` - the closing line can no longer contradict the output above it.
- **The shipped event renderer had no test at all (defect #18).** The 0.8.4 "formatter" test injected a stub
  and passed while the real `formatExpertEvent` in core was never asserted. It now has direct tests, and one
  of them found a real bug: one event could render across two terminal lines, which would desynchronise an
  operator's tail. Rendering is clamped to a single line.
- **The CLI's stream reader dropped the new `attempt` field.** Its frame parser copies only fields it knows,
  so attempt numbers were silently discarded before reaching the renderer - the same whitelist hazard as
  `interactionRounds` in 0.8.4, caught here by a test written against the parser rather than the stub.

### Added
- **A drift guard for the renderer.** Every event kind must now be listed in a `Record` over the
  `ExpertEventKind` union - an unlisted kind fails the build with the property name - and a table-driven test
  requires a rendering expectation for each one. Both halves were proven by injection: adding a kind with no
  coverage entry broke `tsc`, and covering it without testing it reddened the guard.
- **Attempt numbers on every observability event**, rendered as `[role model #2]` for a retried or escalated
  attempt. Ordinary single-attempt runs are unchanged.
## 0.8.5 - 2026-09-16

### Added
- **Struggle detection (`security.guardrails`).** The council now counts what it observes rather than
  what an expert reports, warns the host, and can steer a struggling expert - without ever aborting it.
  - `toolCalls` / `toolErrors` are counted from the runtime's own tool events and ride out on
    `executionMetadata`, into the running views, and into telemetry.
  - `attention` warnings (`consecutive_tool_failures`, `failure_ratio_high`, `budget_fraction`) appear in
    `expert_status({ view: "running" })` regardless of the observability toggle, are written to the event
    stream as `attention` events, and reach a Pi Main Agent as one `expert-council-guardrail` notice each.
  - `nudgeExpert` (default on) steers the expert once per warning, capped at two per execution, and tells
    it the only three things worth doing: change approach, `report_and_stop`, or `request_decision`.
  - `maxTotalWallMs` bounds the aggregate wall clock across all attempts of one delegation. A per-attempt
    budget multiplied by `retry.maxAttempts` is not a budget anybody chose; one mechanical CLI delegation
    cost 58.9 minutes that way before this existed.
- **`executionMetadata.attemptHistory`.** Every delegation with more than one attempt now returns a
  bounded per-attempt record (model, status, failure type, duration, first 300 characters of its summary),
  so a host can reconstruct what happened without opening a state file.
- **Configuration for all of it** under `security.guardrails`, documented with a table in
  [README](README.md#struggle-detection-guardrails) and in `config/examples/balanced.example.json`.

### Fixed
- **A supplier outage is no longer charged to the model.** Transport failures (`Connection error.`,
  `fetch failed`, `bad gateway`, `service unavailable`, `gateway timeout`, `overloaded`, 502/503/504)
  classify as `provider_error` instead of `unknown`, so they mark provider availability and no longer
  degrade that model's reliability aggregate. Observed live twice: two `zai/glm-5.3-flash` worker runs
  died on `Connection error.` and were attributed to the model.
- **`toolErrors` in telemetry was a 0/1 flag wearing a count.** It recorded whether an attempt was
  *classified* as a tool error, which silently starved the tool-error term of `observedAdjustment`; the
  real observed count is used now, with the old classification kept only as a fallback for runtimes that
  cannot observe tool events.
- **`state.json` is written indented**, like every other persisted document. Stored as a single minified
  line it was opaque to our own read-only roles (`read` caps a line at 50KB, `grep` truncates a match to
  500 characters), which is why a per-attempt diagnosis required shell access on the host.
- **Newly persisted outcome fields are registered in the projection whitelist** (`failureType`,
  `toolCalls`, `toolErrorsObserved`, `attentionCodes`) - the same class of silent-drop bug fixed in 0.8.4
  for `interactionRounds`, now covered by a regression test in `tests/guardrails-telemetry.test.ts`.
- **Report text is no longer classified as if it were an error message (defect #16).** `summarizeExpertReport`
  derives a failure type from the expert's own summary, so bare markers like `502`, `overloaded` or
  `server error` would have let a debugger writing "the crash follows a 502 from the gateway" be recorded as
  a supplier outage blamed on the model that wrote the sentence - the exact inversion this release exists to
  prevent. Status codes now match only with HTTP context, and a new `inferFailureTypeFromSummary` classifies
  only failure-shaped text (our own `[Failure]` prefix, or a short line opening with failure vocabulary)
  while real errors keep the message classifier.
- **The verification gate no longer fails falsely inside a worktree.** The suite creates git worktrees
  whose source is the repository it is standing in; when the suite itself runs inside a linked worktree -
  which is exactly what happens when a mutation expert is delegated - git answered
  `fatal: '$GIT_DIR' too big`, and the gate reported a failure for work that was fine. Two experts' correct
  results had been downgraded by it. `tests/global-setup.ts` now detects a linked worktree by comparing
  `--absolute-git-dir` with `--git-common-dir` (never by path length), clones the main checkout once to a
  short path with `git clone --local`, and publishes it to the mutation tests through a handshake file,
  because a globalSetup's `process.env` never reaches vitest workers. Verified both ways: 49/49 from a
  normal checkout and 49/49 from inside a 132-character linked worktree, where the same run previously
  failed 7 tests with the git error.

### Notes
- Detection is deliberately non-blocking: each warning fires at most once per execution (budget warnings
  once per configured fraction) and nothing in this mechanism can abort, approve, or rewrite an expert's
  work. A false positive costs one look; an auto-abort would destroy good work.
- Known limits are documented in README: budget timing assumes the host process is scheduled, a nudge
  requires a runtime session that supports steering, and a tool that hangs instead of failing produces no
  failure count until the attempt times out.

## 0.8.4 - 2026-09-16

### Added
- **The expert window is real.** `security.observability.expertWindow: "interactive"` - previously an accepted-but-inert tier that behaved exactly like `events` - now writes a **live event stream** an operator can follow from a second terminal at zero Main Agent context cost.
  - The Pi runtime appends one bounded JSON object per line to `<dataDir>/observability/<executionId>.jsonl`: `started`, `tool_started`, `tool_finished`, `assistant_text`, `interaction_opened`, `interaction_answered`, then exactly one of `stopped` / `completed` / `failed`. Failed tool calls carry `ok: false`; expert narration is collapsed onto a single bounded line; no tool output and no chain of thought ever reaches disk.
  - `expert-council watch --exec <id> [--follow]` renders it through the same formatter the host uses, tails by byte offset, never prints a partially written line, and **always terminates** - on a terminal event, when `--timeout-ms` (default 300000) elapses, or if the file disappears. `--json` emits raw objects; a missing `--exec` lists the ids that do have streams.
  - `expert_inspect` reports `runtimeCapabilities.eventStream`, so a Main Agent can tell whether the requested tier is actually available. On a runtime that cannot write a stream, `interactive` degrades to `events` and says so in `warnings` - replacing 0.8.3's placeholder notice with a real capability check.
  - Streams are pruned after 7 days, and a failed observability write can never affect an expert run. Observation is deliberately best-effort and **not** an audit log; `expert_verify`, structured `tests[]` evidence, and the Git diff remain the acceptance bar.

### Fixed
- **Verifier routing scored a capability the role can never receive.** The `verifier` role is read-only, and by this project's own isolation rule a read-only execution can never be granted a shell - yet its single largest routing weight was `bashReliability: 0.25`, selecting candidates for a capability they cannot exercise. The role is now weighted on `toolReliability 0.3, review 0.2, longContext 0.15, autonomousExecution 0.1, debugging 0.1, speed 0.1, costEfficiency 0.05`, and a class-guard test asserts that no read-only role weights `bashReliability` and that every role's weights sum to 1, so this cannot recur as roles are added. Found live: a dispatched verifier tried `node --version`, was correctly refused by the isolation rule, and had to report the step as `not-run`.
- **A stop report could be filed with filler and still be credited as delivery.** An expert that called `report_and_stop` with `findings: ["placeholders"]` and a reason reading "no blocker - the report is complete" was accepted as a legitimate stop result: the real deliverable was lost, the run looked terminal, and telemetry recorded the model/role combination as an honest stop. A contentless stop report is now **bounced once** with an explicit correction - state the actual blocker and at least one concrete finding, or return normally if the work is in fact finished. Filler entries are stripped from accepted reports too, and the bounce is capped at one so it can never loop.
- **`interactionRounds` reached the type but never the store.** Since 0.8.0 the council has recorded how many decision/tool-approval rounds an execution raised, `expert_result` reported it correctly, and the field was declared on `ExpertOutcome` — but the local JSONL telemetry store writes through a **whitelist projection** (`sanitizeOutcome`) that never listed it, so every persisted row silently dropped it (0 of 78 rows on the maintainer's own machine). A metric that exists only in the response is not a learning signal: routing can only use what survives locally. The field is now persisted, clamped to a non-negative integer, and still omitted when an execution never interacted. The regression test asserts both directions (present → written, absent → not invented), and the projection now carries a comment naming this hazard, because any newly added persisted field must be listed there or it vanishes quietly.
  - Scope note, stated rather than implied: aggregates do not *consume* the value yet. It is recorded locally so the conservative reliability adjustment has the data available; no claim is made that routing already learns from it.

### Changed
- **`security.observability.redactToolArgs` returns with real behavior.** It was removed in 0.8.3 for being an inert placebo; now that an event stream exists to redact, it decides whether tool invocations are recorded by name only (default `true`) or with a bounded argument summary that can contain file paths and complete command lines. Configurations that carried the key throughout 0.8.3 keep loading unchanged.

### Documentation
- Added "Observability and the expert window" (and its 中文 mirror): all three tiers, the file layout, every `watch` flag, the redaction tradeoff, and the fact that a stream can only be followed from the same data directory as the running host.
- Corrected a stale provisioning claim that repositories using `uv.lock`, `requirements.txt`, `Cargo.toml`, or `go.mod` "are reported as skipped because no supported provisioning exists" - the committed driver registry has materialized those ecosystems since 0.8.0.
- The shared Agent Skill gained an observation item: point the operator at `expert-council watch` rather than relaying live progress back into the Main Agent's context, which is the cost delegation exists to avoid.

### 中文

## 0.8.6（中文）

### 修复
- **专家窗口不再在委派中途关闭（缺陷 #17）。** 现场发现于第一次跨进程演示：一个 scout 的首次尝试死于供应商故障，Council 升级到另一个模型并成功完成任务，而 `expert-council watch --follow` 早已打印 `stream closed (failed)` 退出——运维者只看到失败，永远看不到真正完成的那次尝试。根因是每次尝试都会写自己的终止事件，而 watch 把任意终止事件当成了流的尽头。现在 Council 在委派真正结束时写一条委派级 `delegation_final` 标记，watch 认它关闭；没有该标记的流（旧运行时、或进程已死）改为在 750ms 无增长后关闭，`--timeout-ms` 仍然是所有等待的上界。反证已做：恢复旧规则会让 3 条 watch 用例变红，其中正是升级那一条。
- **首次尝试的挣扎不再因为重试成功而消失（缺陷 #20）。** 交付的 `executionMetadata` 带的是运行时**最后一次**尝试所见：第 1 次尝试反复工具失败烧光预算后，只要第 2 次干净完成，结果里就一条警告都不剩；遥测又把累加的 `toolErrors` 与单次尝试的 `toolCalls` 混在一起。现在由 Council 折算整条委派的总量：`toolCalls`、`toolErrors`、以及跨尝试按 code 去重的 `attention`（末 8 条）。
- **挣扎告警到了运维终端却把正文丢了（缺陷 #21）。** `formatExpertEvent` 没有 `attention` 分支，于是落进 default 只印出裸的种类名——现场那两行 `attention` 不知所云。现在渲染为 `WARNING: <正文> (budget 60%, tool errors 1/2, expert steered)`。
- **护栏计数没能进入事件流，即便进入了也会在管道另一端被丢掉（缺陷 #22）。** 运行时只写告警文本，而 CLI 帧读取只复制它认识的字段，同一根管子两头都在丢数据。两端一起修、各自单独测——“字段存在”与“字段能穿过投影”是两个不同的 bug：与 0.8.4 的 `interactionRounds`、0.8.6 的 `attempt` 同一课。
- **读不出来的工作区 diff 不再冒充“工作树是干净的”（缺陷 #28）。** `WorkspaceBoundary.changedFiles` 会把自身的 `git status` 失败吞掉并返回 `[]`，于是一个可写专家只要 diff 读不出来——#11 那类 `$GIT_DIR` too big 正走这条路——就被报成“什么都没改”；照 `filesChanged` 做集成的宿主于是把真实成果集成为零。“无法判断”现在是一个独立的答案：所有会收集文件的交付路径（成功、超时、会话错误、抛错、中止、专家自停）都会给出 `executionMetadata.filesChangedError` 加一条 risk。并按这一族把全仓扫了一遍：70 个 `catch`、其中 15 个块内没有任何语句，逐个读过——其余都是有意为之（可选的 Pi 能力探测、竞态删除、宿主拒收的通知、拆除阶段），并把理由写在了代码旁边。
- **把“试过了”当成“送出了”的计数器（缺陷 #29）。** `watchForInteractions` 在调用宿主之前就 `sent += 1`，于是宿主每次都拒绝时它仍报告送出了一条——而且旧测试断言的正是这个谎。现在只统计宿主真正接受的条数，与护栏计数顺序一致；测试是**加强**而非削弱：额外钉住“拒绝的宿主也只会被试一次”，因为去重键在发送失败时同样已被消费。
- **测试目录从来没被类型检查（缺陷 #24）。** 根 tsconfig 是 solution 式工程（`"files": []` + 包引用），所以 `npm run typecheck` 只看 `packages/*`。写在测试里的类型级守卫因此全是装饰——包括同一天刚加的两条：`Record<keyof ExpertOutcome, ...>` 与 `EVENT_KIND_COVERAGE`。`tsconfig.tests.json` 现在刻意 extends `tsconfig.base.json`，让测试面对项目**真实**严格度（`noUncheckedIndexedAccess`、`verbatimModuleSyntax`）而不是一份更宽松、少报 8 条的副本；`typecheck` 两半都跑。报出的 59 条全部属于夹具层，已清零。
- **有一条绿灯其实什么都没测（缺陷 #25）。** `does not mark transient provider failures such as rate limits` 断言的恰恰是已发布契约的**反面**，而它之所以通过，是因为它的持久化 stub 引用了 `current`——那只是类型标注名、不是运行时绑定——于是每次调用都抛 `ReferenceError`，落进 `service.ts` 里那个尽力而为的 `catch`，什么也没记下来。限流**确实**会标记，而且是故意的：走 2 分钟的 `MODEL_RATE_LIMIT_MARKER_TTL_MS` 窗口而非封锁窗口、并连同 provider 兄弟模型一起标，仓库那次限流修复正是依赖此。现在这条测试钉的是真实契约；它的夹具会自报异常，坏掉的 stub 再也不可能把断言喂绿；过期时间也用导入常量证明。双向反证：让限流不再算证据 → 标记断言红；让限流用封锁 TTL → 过期断言红。
- **尽力而为的持久化不再隐形（缺陷 #26）。** 那个静默 `catch` 正是 #25 能藏住的使能条件。标记没能落盘，意味着下一次委派会重演这一次已经撞过的失败，所以现在记为 `executionMetadata.persistenceErrors` 并作为 risk 上报——同时仍然绝不中断委派，那才是这个 catch 的本意。
- **`routePolicy` 明明必填却按可选读（缺陷 #27）。** `presentResourceInventory` 里五处 `?.` 暗示了一个 `ResourceInventory` 从来不允许的空值场景；全仓也没有绕过该必填的 cast，现在直读。
- **静默兜底把专家的沉默误判成流已死（缺陷 #23）。** 修好后的窗口首跑就看到了：一次三次尝试的委派按时写出 `delegation_final`，而观察者早在 13 秒前就离开——只因 750ms 内没有新行；那不过是模型在思考或构建在跑的普通停顿。兜底阈值改为默认 15 秒，可用 `--quiet-ms` 调整；真正的信号仍是那条标记，或运维者自己设的 `--timeout-ms`。
- **`watch` 关闭时报告的结局是错的（缺陷 #19）。** 一次先失败后成功的委派会自称 `stream closed (failed)`，因为观察者记住了它看到的**第一个**终止事件。现在它记住最后一个；由委派级标记驱动的关闭会说 `stream closed (delegation finished)`——收尾那行再也不能和自己上面的输出相矛盾。
- **出厂的事件渲染器此前完全没有测试（缺陷 #18）。** 0.8.4 那条"格式化器"测试注入的是桩，测试通过而 core 里真正的 `formatExpertEvent` 从未被断言过。现在它有直接测试，并且当场抓到一个真 bug：一条事件可以渲染成两行终端输出，会让运维者的 tail 与流失步。渲染已强制压成单行。
- **CLI 的流读取器会丢掉新的 `attempt` 字段。** 它的帧解析只复制自己认识的字段，尝试序号因此在到达渲染器之前就被静默丢弃——与 0.8.4 的 `interactionRounds` 同类的白名单陷阱，这次靠"对解析器而不是对桩"写的测试抓到。

### 新增
- **渲染器的防漂移守卫。** 每个事件种类现在都必须在 `ExpertEventKind` 联合类型上的一个 `Record` 里登记——漏登就编译失败并点名缺的键；另有一条表驱动测试要求每个种类都有渲染断言。两半都用注入法验证过：加种类不登记会打断 `tsc`，登记却不测则守卫变红。
- **每个可观测事件都带尝试序号**，重试或升级的尝试渲染为 `[role model #2]`。单次尝试的普通运行保持原样。
## 0.8.5（中文）

### 新增
- **挣扎检测（`security.guardrails`）。** Council 开始按**自己观测**到的事实而非专家的自述来判断它是否卡住，会通知宿主，也可以在必要时 steer 专家——但从不中止它。
  - `toolCalls` / `toolErrors` 由运行时在自己的工具事件上计数，随 `executionMetadata`、运行视图与遥测一起输出。
  - `attention` 警告（`consecutive_tool_failures`、`failure_ratio_high`、`budget_fraction`）会出现在 `expert_status({ view: "running" })`，**不受可观测开关约束**；同时写入事件流（`attention` 事件），并作为一条 `expert-council-guardrail` 原生通知发给 Pi 主代理。
  - `nudgeExpert`（默认开）每条警告最多 steer 一次、每次执行最多两次，只告诉专家三件值得做的事：换做法、`report_and_stop`、或 `request_decision`。
  - `maxTotalWallMs` 为一次委派的**全部尝试**设总时长上限。单次预算乘以 `retry.maxAttempts` 不等于任何人选择的预算——在此之前，一个机械的 CLI 任务正是这样花掉 58.9 分钟。
- **`executionMetadata.attemptHistory`。** 超过一次尝试的委派现在返回有界的逐次记录（模型、状态、失败类型、耗时、摘要前 300 字符），宿主无需翻状态文件即可复盘。
- 全部选项集中在 `security.guardrails`，README 有表格说明，`config/examples/balanced.example.json` 给出示例。

### 修复
- **供应商故障不再算到模型头上。** 传输类失败（`Connection error.`、`fetch failed`、`bad gateway`、`service unavailable`、`gateway timeout`、`overloaded`、502/503/504）归为 `provider_error` 而不再是 `unknown`，因此能正确标记提供商可用性，也不再拉低该模型的可靠性聚合。现场两次证据：两次 `zai/glm-5.3-flash` worker 都死于 `Connection error.`，却记在模型账上。
- **遥测里的 `toolErrors` 曾是一个伪装成计数的 0/1 标志。** 它记录的是「这次尝试是否被*分类*为工具错误」，导致 `observedAdjustment` 的工具错误项长期饥饿；现在使用真实观测计数，旧分类仅作为无法观测工具事件的运行时的兜底。
- **`state.json` 改为缩进写盘**，与其他持久化文档一致。此前单行 minified 对我们自己的只读角色完全不透明（`read` 每行上限 50KB，`grep` 把命中截断到 500 字符），这正是逐次诊断必须借宿主 shell 的原因。
- **新增持久化字段已登记进投影白名单**（`failureType`、`toolCalls`、`toolErrorsObserved`、`attentionCodes`）——与 0.8.4 修复的 `interactionRounds` 静默丢弃属同一类缺陷，现由 `tests/guardrails-telemetry.test.ts` 的回归测试守住了。
- **报告文本不再被当成错误消息分类（缺陷 #16）。** `summarizeExpertReport` 会从专家自己的摘要推导失败类型，于是 `502`、`overloaded`、`server error` 这类裸标记会让一句“崩溃跟随网关返回的 502”被记成供应商故障、并算到写出这句话的模型头上——这正是本次发布要消除的倒置。现在状态码必须带 HTTP 上下文才匹配；新增 `inferFailureTypeFromSummary` 只判定“形似失败”的文本（我们自己的 `[Failure]` 前缀，或以失败词汇开头的短行），真实错误仍走消息级分类器。
- **验证门不再在 worktree 内假失败。** 测试套件的 worktree 以「自己所在的仓库」为源；当套件本身跑在 linked worktree 里（正是委派可写专家时发生的情形），git 会回 `fatal: '$GIT_DIR' too big`，于是明明没问题的成果被判失败——已有两位专家的正确结果因此降级。`tests/global-setup.ts` 现在用 `--absolute-git-dir` 与 `--git-common-dir` 比对来识别 linked worktree（绝不用路径长度猜），以 `git clone --local` 一次性把主检出克隆到短路径，并经由一个握手文件交给需要真实 git 源的可写测试——因为 globalSetup 里的 `process.env` 根本传不到 vitest worker。双向证实：普通检出 49/49，132 字符的 linked worktree 内同样 49/49（同样的运行此前有 7 项因该 git 错误失败）。

### 说明
- 检测刻意做成非阻塞：每条警告每次执行最多一次（预算警告按配置分位各一次），且整个机制不能中止、批准或改写专家的工作。误报只损失一次查看，自动中止会毁掉好成果。
- 已知限制见 README：预算计时假设宿主进程确实被调度；nudge 需要会话支持 steer；工具「卡住」而非报错时，在该次尝试超时前不会计入失败。

## 0.8.4（中文）

### 新增
- **专家窗口真的实现了。** `security.observability.expertWindow: "interactive"`——此前只是一个能填但行为等同 `events` 的空档位——现在会写入一份**实时事件流**，运维者可在另一个终端跟随，且不花主代理任何上下文。
  - Pi 运行时向 `<数据目录>/observability/<executionId>.jsonl` 逐行追加有界 JSON 对象：`started`、`tool_started`、`tool_finished`、`assistant_text`、`interaction_opened`、`interaction_answered`，最后恰好一个 `stopped` / `completed` / `failed`。失败的工具调用带 `ok: false`；专家叙述被压成单行有界文本；工具输出与思考链永远不会落盘。
  - `expert-council watch --exec <id> [--follow]` 用与宿主相同的格式化器输出，按字节偏移量追读，绝不输出未写完的半行，且**一定会退出**——遇到终止事件、超过 `--timeout-ms`（默认 300000）、或文件消失。`--json` 输出原始对象；未指定 `--exec` 时会列出当前有流的可执行 ID。
  - `expert_inspect` 报 `runtimeCapabilities.eventStream`，主代理因此能判断所请求档位是否真可用。写入能力缺失时 `interactive` 降级为 `events` 并在 `warnings` 里说明——把 0.8.3 那个占位告警换成了真能力探测。
  - 事件流 7 天后清理；写入失败永远不可能影响专家执行。可观测性有意只是尽力而为，**不是**审计日志；`expert_verify`、结构化的 `tests[]` 证据与 Git diff 仍是验收标准。

### 修复
- **Verifier 的路由权重在考核一个角色永远拿不到的能力。** `verifier` 是只读角色，而根据本项目自己的隔离规则，只读执行永远不会被授予 shell——但它最大的单项路由权重恰恰是 `bashReliability: 0.25`，在用一个无法行使的能力挑选候选。现改为 `toolReliability 0.3、review 0.2、longContext 0.15、autonomousExecution 0.1、debugging 0.1、speed 0.1、costEfficiency 0.05`；并新增类不变量测试：任何只读角色都不得权重 `bashReliability`，且所有角色权重之和必须为 1，以免未来新增角色时重跨。该缺陷是实机发现的：一个 verifier 尝试 `node --version`，被隔离规则正确拒绝，只能把那一步报为 `not-run`。
- **停止报告可以只交占位内容却被当成已交付。** 专家调用 `report_and_stop` 时写 `findings: ["placeholders"]`、理由却是“没有障碍——报告已完成”，仍被当成合法的停止结果接受：真实交付物丢了，执行看起来已终止，遥测还把那个模型/角色组合记为一次诚实停止。现在无实质内容的停止报告会**被退回一次**并附上明确纠正——写清真正的障碍与至少一条具体发现，或者若确实做完了就正常返回。已接受的报告也会滤掉占位项；退回最多一次，绝对不会循环。
- **`interactionRounds` 到了类型，却没到存储。** 自 0.8.0 起，议会会记录一次执行提出了多少个决策/工具审批交互，`expert_result` 也正确上报，`ExpertOutcome` 上更声明了该字段——但本地 JSONL 遥测存储经一个**白名单投影**（`sanitizeOutcome`）写盘，而该投影从未列入这个字段，于是每一条持久化记录都静默丢弃了它（维护者自己机器上 78 行里 0 行含该字段）。只存在于响应里的指标不是学习信号：路由只能用本地留得下来的数据。现在该字段会被写入、被限制为非负整数，且未发生交互时照旧不出现。回归测试断言两个方向（有→写入，无→不凭空生成）；投影处也加了注释点明这个陷阱，因为今后任何新增的持久字段若不在那里登记就会静默消失。
  - 范围如实说明：聚合指标**尚未**消费 `interactionRounds`。它只是先记录在本地，供保守的可靠性调节取用；并不声称路由已经从中学习。

### 变更
- **`security.observability.redactToolArgs` 带真行为回归。** 0.8.3 因它是个空转安慰剂而移除；现在既然确实存在一份可被脱敏的事件流，它决定工具调用是只按名称记录（默认 `true`），还是同时写入有界的入参摘要（可能含文件路径与完整命令行）。在 0.8.3 期间仍携带该键的配置照旧加载。

### 文档
- 新增“可观测性与专家窗口”一节（含中文镜像）：三个档位、文件布局、`watch` 全部参数、脱敏取舍，以及事件流只能从与运行宿主相同的数据目录里跟随这一事实。
- 修正一处关于供给的过时断言：说使用 `uv.lock`、`requirements.txt`、`Cargo.toml`、`go.mod` 的仓库“会被报为跳过，因为不存在支持的供给方式”——提交的驱动注册表自 0.8.0 起就已为这些生态物化环境。
- 共享 Agent Skill 新增一条观测守则：把运维者引向 `expert-council watch`，而不是把实时进度转述进主代理上下文——那正是委托本要避免的成本。

## 0.8.3 - 2026-09-16

### Fixed
- **Two interactions raised in one assistant turn no longer orphan each other.** Role tools are a seed, not a ceiling — but until now only one request at a time could actually be served. An expert that issued two `request_decision`/`request_tool` calls in the same turn overwrote the single `pendingInteraction` slot: the first tool call kept waiting for an answer the host could no longer see, and only released when the 15-minute wait timeout expired. Exactly one interaction may now be open per execution: a concurrent second request is refused immediately with an explicit instruction to choose the conservative option and note the assumption, and the refusal is not charged against the per-execution round budget. A regression test drives the real custom-tool path with two concurrent requests and is verified in both directions (guard removed → fails, guard present → passes).

### Changed
- **`security.observability.redactToolArgs` removed.** It was accepted, validated, documented — and read by nothing, because no code path ever surfaced tool arguments. A control that changes nothing is worse than no control: it teaches operators to trust the wrong knob. Configurations that still carry the key continue to load unchanged (the `observability` block ignores unknown keys).
- **`expert_inspect` now echoes the effective `security.observability` values** (`expertWindow`, `streamToHost`) and emits a warning when `expertWindow: "interactive"` is configured, since that tier has no distinct behavior until an RPC projection exists and otherwise silently behaves as `events`.

### Documentation
- Corrected the advertised MCP tool count: the MCP Server exposes **13** `expert_*` tools; the native Pi Package exposes **12** (`expert_wait` is MCP-only, because a Pi host can await natively). A new test asserts both READMEs' stated counts against the tool registry, so this class of drift cannot recur silently.
- Stated precisely what the progress toggle does *not* gate: the `pendingInteraction` correctness channel and an explicit `expert_result(includeProgress)` snapshot are always available, so `expertWindow: "off"` means "no ambient progress stream", not "no way to see where an expert is". Also noted that read-only runs correctly report no `filesChanged`.

### 中文

### 修复
- **同一助手轮次内发起两个交互不再互相孤儿化。** 角色工具是种子而非上限——但此前同一时刻只有一个请求真能被服务。专家在同一轮发出两个 `request_decision`/`request_tool` 时，会覆写唯一的 `pendingInteraction` 位：第一个工具调用继续等待一个宿主已看不见的答复，直到 15 分钟等待超时才释放。现在每次执行只允许一个未决交互：并发的第二个请求会被立即拒答，并附上“自行选择保守选项并记录假设”的明确指令，且不扣除该执行的交互轮次预算。回归测试以两个并发请求驱动真实 custom tool 路径，并双向反证（去掉守卫 → 红；守卫在位 → 绿）。

### 变更
- **移除 `security.observability.redactToolArgs`。** 它被接受、被校验、被写入文档，却没有任何代码读取它——因为根本没有任何路径会外抛工具入参。一个改变不了任何行为的开关比没有开关更糟：它会让运维者误信错误的旋钮。仍携带该键的配置照旧加载不变（`observability` 块忽略未知键）。
- **`expert_inspect` 现在回显生效的 `security.observability` 值**（`expertWindow`、`streamToHost`），并在配置为 `interactive` 时给出告警——该档在 RPC 投影实现前并无独立行为，否则它只会静默等同 `events`。

### 文档
- 修正对外宣称的 MCP 工具数：MCP Server 暴露 **13** 个 `expert_*` 工具；原生 Pi Package 暴露 **12** 个（`expert_wait` 仅 MCP 提供，因为 Pi 宿主能原生等待）。新增测试将两份 README 所写的工具数对照工具注册表断言，使这类口径漂移无法悄悄重现。
- 明说进度开关**不**约束哪些通道：`pendingInteraction` 正确性通道与宿主显式索取的 `expert_result(includeProgress)` 快照始终可用，所以 `expertWindow: "off"` 意为“不持续播报环境进度”，而非“无法得知专家跑到哪”。同时注明只读执行正确地不上报 `filesChanged`。

## 0.8.2 - 2026-09-15

### Fixed
- **The host-bound expert abort no longer silently disappears on fresh installs.** The `session_shutdown` handler read the operator config to decide between `host-bound` and `detached` lifetime, but it passed the optional data-directory `council-config.json` as an **explicit** config path — and an explicit path is a promise the operator made, so a missing file throws. On any install that never created that file (the documented zero-config default), the throw was swallowed by the teardown `catch`, the lifetime check never ran, and running experts were **never aborted**: orphaned experts kept burning provider quota with no receiver for their results. This affected every distribution's native Pi path since 0.7.7 and was invisible to anyone who had already created a config file.
  - The optional file is now loaded as the optional default it is, and an unreadable configuration falls back to `host-bound` — failing toward aborting rather than toward leaving orphans.
  - A regression test drives the real `session_shutdown` handler against an empty data directory; it reproduces the shipped failure and passes only with the fix (verified both directions).

### Notes
- The README's operator-config resolution wording was checked against the code and the CLI rather than assumed: an explicit `configPath` or `EXPERT_COUNCIL_CONFIG` really must point at an existing file (`expert-council models` exits 1 with `Unable to read Expert Council config … ENOENT`), while the data-directory default is optional and silently skipped. The documentation was correct; the shutdown path was the one place that violated it.

## 0.8.2（中文）

### 修复
- **全新安装下，host-bound 的专家中止不再静默失效。** `session_shutdown` 处理需读取运营者配置以判定 `host-bound` 还是 `detached` 生命周期，但它把可选的数据目录 `council-config.json` 当成了**显式**配置路径传入——而显式路径代表运维者做出的承诺，文件缺失就会抛错。于是在任何未创建该文件的安装（即文档承诺的零配置默认）上，异常被 teardown 的 `catch` 吞掉，生命周期判定从未执行，运行中的专家**永不被中止**：孤儿专家在无人接收结果的情况下持续消耗供应商配额。该缺陷自 0.7.7 起存在于各分发的原生 Pi 路径，且对早已建过配置文件的人完全不可见。
  - 现在按本来的语义把该文件当作可选默认项加载；配置不可读时回退到 `host-bound`——宁可中止也不留孤儿。
  - 新增回归测试：用空数据目录驱动真实的 `session_shutdown` 处理；它能复现已发布的失效，且仅在修复后通过（两个方向均已验证）。

### 说明
- README 关于运营者配置解析顺序的表述已比对代码与 CLI 实测，而非臆断：显式 `configPath` 或 `EXPERT_COUNCIL_CONFIG` 确实必须指向存在的文件（`expert-council models` 会以 `Unable to read Expert Council config … ENOENT` 退出码 1），而数据目录默认项可选且缺失静默跳过。文档是对的；违反它的只有 shutdown 这条路径。

## 0.8.1 - 2026-09-15

### Fixed
- Read-only experts are told that handing back the requested content, analysis, or replacement text inside their report **is** completion, and must not report `partial` with `failureType: permission_error` merely because their role cannot write files; that failure type is reserved for runs that could not produce the requested result at all. Observed live: a scout produced exactly the condensed sentence its host asked for and then self-labelled a permission error, which taught local telemetry to record a correctly finished run as a failure and would have degraded that model's future routing scores. Fail-fast semantics are unchanged — `permission_error` still terminates the delegation loop without retry or escalation.
- The shared Skill now guides hosts to ask a read-only expert to *return* text or findings rather than to *apply* or *fix* them, so the assignment matches the role's capability; applying a change stays an implementation-worker or debugger job.

### Notes
- 0.8.0 was re-verified against the artifacts npm actually served: published tarballs matched the registry shasum, every 0.8.0 feature marker was present in the installed `dist`, thirteen MCP tools and twelve Pi-package tools registered, and the interaction path was exercised live twice more — the native Pi notice woke the host with zero polling, and the previously untested `allowOther` free-text branch was honoured verbatim (the expert applied a host answer that was neither offered option).

## 0.8.1（中文）

### 修复
- 明确告知只读专家：把所需内容、分析或替换文本写进报告**就是完成**，不得仅因角色不能写文件而返回 `partial` 并标 `failureType: permission_error`；该失败类型只用于“根本产不出要求结果”的情形。实机观测到：某 scout 已精确产出宿主要求的压缩句，却自标权限错误，导致本地遥测把一次正确完成的运行记成失败，并会拉低该模型后续的路由评分。fail-fast 语义不变——`permission_error` 仍然终止委托循环，不重试也不升级。
- 共享 Skill 新增宿主侧指引：让只读专家 *返回* 文本或结论，而不是让它 *应用* 或 *修复*，以匹配角色的能力边界；落地修改仍由 implementation-worker 或 debugger 负责。

### 说明
- 对 npm 实际分发的 0.8.0 产物做了复验：发布 tarball 与 registry shasum 一致、已安装 `dist` 含全部 0.8.0 特性标记、MCP 注册 13 个工具且 Pi 包注册 12 个；交互链路又实机跑了两次——原生 Pi 通知在零轮询下唤醒宿主，且此前未验证的 `allowOther` 自由文本分支被逐字执行（专家采用了两个备选项之外的宿主答复）。

## 0.8.0 - 2026-09-11

### Added — Interactive experts, dynamic permissions, cross-language environments

- **Real-time decision points.** Experts can pause mid-task on a genuinely major, hard-to-reverse, or ambiguous direction and present 2-4 recommended options (plus optional free text) to the Main Agent via a new `request_decision` tool; the Main Agent answers with the new `expert_respond` tool and the expert continues in the **same session** with its context and file work intact. Non-terminal by design — distinct from `report_and_stop` (task impossible).
- **Dynamic tool permissions.** Preset role tools are now a starting **seed, not a ceiling**. An expert that needs a tool its role lacks calls `request_tool`; the Main Agent grants `once` (auto-revoked after a single use), `persistent` (for the rest of the session), or `reject`. `security.toolGrants` provides operator-defined persistent per-role grants applied at session start. A read-only execution can **never** be escalated to a mutating or shell tool — that would break the isolation guarantee, since read-only experts run in the main workspace.
- **Expert interaction is surfaced on a correctness channel.** A running expert's open interaction appears in `expert_status(view:"running")` and `expert_result(includeProgress)` as `pendingInteraction`, so a headless host (Codex/MCP, which has no server-push) discovers it by polling and answers it. Interactions are bounded per execution (default 3 rounds, a wait timeout) and never wedge a run.
- **Cross-language environments.** `provisionWorkspace` is no longer Node-only. A data-driven driver registry materializes mainstream ecosystems from each toolchain's already-global download cache (pnpm store, `~/.cargo`, `GOMODCACHE`, `~/.m2`, `~/.nuget`, pip/uv cache, bundler, composer, hex): node/pnpm/yarn/bun, python (uv/poetry/venv-host), rust, go, jvm/maven, dotnet, ruby, php, elixir. Environment-as-code backends (`flake.nix`, `.devcontainer/`) are detected and surfaced for delegation rather than re-implemented. `security.workspaceProvisioning` gains `strategy` (auto/drivers/as-code/in-place) and `runtimeEnv` (isolated/host-env). A worktree never shares a recompiled build/target directory across concurrent experts (cargo locks its target).
- **Progress observability toggle.** `security.observability.expertWindow` (`off` default / `events` / `interactive`) surfaces bounded live progress (message count, last activity) in the running view; `events` mode adds it, the pending-interaction channel stays on regardless. `interactive` (RPC projection) is intentionally not implemented in 0.8.0.
- **Telemetry** records `interactionRounds` per execution to inform routing.
- **Native Pi wakes the host for interactions.** While dispatched executions are live, the Pi package polls the bounded running view and sends an `expert-council-interaction` notice the moment an expert opens a decision or tool request, deduplicated per round and delivered over the same steer/followUp path as completion notices. Observation is best-effort: if a notice cannot be delivered, the interaction is still discoverable through `expert_status` and `expert_result`.

### Changed
- `expert_status` running/summary views are async-enriched with live interaction and (when enabled) progress.
- MCP / Pi-package / CLI all expose `expert_respond`; the CLI gains `respond`.
- `expert_delegate` no longer demands top-level `timeoutMs`/`reasoningLevel` when an `assignments` array is used — each entry carries its own, so batch dispatches stopped paying for a redundant pair of arguments. A single assignment must still state both, and both hosts now say so with an actionable error (Pi does not validate tool input schemas, so the native path checks it in code).
- New administrative input `EXPERT_COUNCIL_WORKTREES` redirects the parent of the private expert worktree base (the per-user private subdirectory and all validation stay in force). The automated test suite now routes its expert worktrees into a throwaway directory and prunes them, instead of accumulating registered worktrees in the live per-user namespace.

### Fixed
- A read-only expert no longer reports the Main Agent's own uncommitted files as `filesChanged`. Read-only runs share the main workspace, so the git-dirty set belonged to the host; attributing it to the expert fabricated authorship and could make a host try to integrate or clean up its own in-progress edits. This also applies to live progress (`filesChangedSoFar`) and failure artifacts, matching what the failure-evidence contract already promised.
- `expert_cleanup` on a read-only execution now returns `not-required` with an explanation instead of `not-found`, which previously made a valid ID look lost or mistyped; `not-found` still means a real missing worktree for an isolated run.
- `expert_inspect` now forwards `realtimeInteraction` and `dynamicToolPermissions` in `runtimeCapabilities`; the presentation layer dropped them, so hosts could not discover that the 0.8.0 interaction and grant features exist.
- On the MCP path, a single-assignment `expert_delegate` call dropped its `reasoningLevel` before reaching the runtime: the argument was schema-required but never forwarded, so a host-chosen effort level (for example from Codex) was silently ignored and the expert ran at the composition or default level. Batch calls forwarded it correctly, so only single delegations were affected.

### Notes
- Built on verified Pi primitives: `session.steer/followUp/subscribe/setActiveToolsByName`, custom-tool resolve (same template as `report_and_stop`). Live validation against a real model confirmed the two non-obvious ones: `setActiveToolsByName` genuinely restricts the model's visible tools (so a role seed stays the default even though mutation-capable executions register a wider built-in set to make grants possible), and a granted tool really executes. Verified live end-to-end: an expert raised `request_decision` with two options, the host answer let it finish in the same session applying the choice; another expert requested `powershell`, was granted it, and returned a correct command result. The passive tool-call block (auto-raising approval on an un-granted built-in) degrades to the expert proactively calling `request_tool`, since it cannot invoke a tool that is not in its active set — documented rather than faked.

## 0.8.0（中文）

### 新增 — 交互式专家、动态权限、跨语言环境

- **实时决策点**：专家可在真正重大、难以回退或方向含糊处暂停，通过新 `request_decision` 工具向主代理给出 2-4 个推荐选项（含可选自由文本）；主代理用新 `expert_respond` 回答，专家在**同一会话**带上下文与已改文件继续。设计上非终止，与 `report_and_stop`（任务不可完成）区分。
- **动态工具权限**：预设角色工具现为起始**种子而非上限**。缺工具的专家调 `request_tool`，主代理授予 `once`（用一次后自动撤销）/`persistent`（会话内持久）/`reject`。`security.toolGrants` 提供运维侧持久按角色授予，会话起始并入。只读执行**永不**可升级为变更/shell 工具——那会破坏隔离保证（只读专家在主工作区运行）。
- **交互经正确性通道浮现**：运行中专家的未决交互以 `pendingInteraction` 出现在 `expert_status(view:"running")` 与 `expert_result(includeProgress)`，无推送的无头宿主（Codex/MCP）可轮询发现并回答。每执行交互次数有界（默认 3 轮 + 等待超时），绝不卡死。
- **跨语言环境**：`provisionWorkspace` 不再只支持 Node。数据驱动注册表从各工具链**已有的全局下载缓存**（pnpm store、`~/.cargo`、`GOMODCACHE`、`~/.m2`、`~/.nuget`、pip/uv 缓存、bundler、composer、hex）物化主流生态：node/pnpm/yarn/bun、python(uv/poetry/宿主venv)、rust、go、jvm/maven、dotnet、ruby、php、elixir。环境即代码后端（`flake.nix`、`.devcontainer/`）被检测并交还委托而非重造。`security.workspaceProvisioning` 新增 `strategy`（auto/drivers/as-code/in-place）与 `runtimeEnv`（isolated/host-env）。并发专家间绝不共享重编译 target 目录（cargo 对其持锁）。
- **进度可观测开关**：`security.observability.expertWindow`（默认 `off` / `events` / `interactive`）在 running 视图浮现轻量进度（消息数、最近活动）；`events` 档开启之，未决交互通道则始终开启。`interactive`（RPC 投影）0.8.0 有意未实现。
- **遥测**记录每执行 `interactionRounds` 供路由参考。
- **原生 Pi 会为交互唤醒宿主**。已派发执行仍存活期间，Pi 包轮询有界的 running 视图，专家一打开决策或工具请求就发送 `expert-council-interaction` 通知，按轮次去重，并复用完成通知的 steer/followUp 通道。观测属尽力而为：通知投递失败时，交互仍可经 `expert_status` 与 `expert_result` 发现。

### 变更
- `expert_status` running/summary 视图异步富集实时交互与（开启时）进度。
- MCP / Pi 包 / CLI 均提供 `expert_respond`；CLI 新增 `respond`。
- 使用 `assignments` 数组时，`expert_delegate` 不再要求顶层 `timeoutMs`/`reasoningLevel`——每项已自带超时与推理档位，批量派发不必再多供一对冗余参数。单次委派仍须明确两者，两个宿主现在都会给出可照着改的错误说明（Pi 不校验工具入参 schema，所以原生路径在代码里检查）。
- 新增管理型输入 `EXPERT_COUNCIL_WORKTREES`，可重定向私有专家 worktree 基目录的父目录（按用户隔离的私有子目录与全部校验仍然生效）。自动化测试现将专家 worktree 路由到一次性目录并自行清理，不再在实时按用户命名空间里堆积注册项。

### 修复
- 只读专家不再把主代理自己的未提交文件报成 `filesChanged`。只读执行共用主工作区，那份 git 脏集合属于宿主；归给专家等于伪造作者身份，并可能诱导宿主去集成或清理自己正在进行的编辑。实时进度（`filesChangedSoFar`）与失败工件同样修正，与失败证据契约原本的承诺一致。
- 对只读执行调用 `expert_cleanup` 现返回带解释的 `not-required`，不再返回 `not-found`（此前会让合法 ID 看起来像写错或丢失）；隔离执行的 worktree 确实缺失时仍报 `not-found`。
- `expert_inspect` 现在会在 `runtimeCapabilities` 中转发 `realtimeInteraction` 与 `dynamicToolPermissions`：呈现层此前将其丢弃，导致宿主无法发现 0.8.0 的交互与授权能力存在。
- MCP 路径上，单次委派的 `expert_delegate` 会在抵达运行时前丢掉 `reasoningLevel`：该参数被 schema 强制要求却从未转发，因此宿主（例如 Codex）精心选的推理档位被无声忽略，专家按编排或默认档位运行。批量调用转发正确，故仅单次委派受影响。

### 说明
- 构建于已核实的 Pi 原语：`session.steer/followUp/subscribe/setActiveToolsByName`、custom-tool resolve（与 `report_and_stop` 同模板）。针对真实模型的实机验证确认了两处非常显然的行为：`setActiveToolsByName` 确实会限制模型可见工具（因此即便为让授权成为可能而向变更型执行注册更宽的内建集，角色种子仍是默认），且被授予的工具能真正执行。端到端实测通过：一个专家提出含两个选项的 `request_decision`，宿主答复后其在同一会话按所选继续完成；另一个专家申请 `powershell` 获授后返回了正确命令结果。被动工具门（在未授权内建工具被调用时自动弹审批）降级为专家主动调 `request_tool`（未激活的工具本就无法被调用）——如实文档化而非假装。

## 0.7.10 - 2026-09-11

### Fixed

- **State reload corruption from the `timeoutMs` execution field (0.7.9 regression)**: 0.7.9 added `ExecutionStateSnapshot.timeoutMs` (for the status-view remaining time) but did not add it to the strict persisted-execution schema, so any execution that ran wrote a `timeoutMs` the loader rejected — making the entire `state.json` unreadable after a host restart or in a fresh process ("Unrecognized key: timeoutMs"). The field is now in the schema, and the execution snapshot uses `passthrough()` so a schema lag on a future optional execution field can never again wedge the whole state (the same forward-compatibility guarantee already applied to `executionMetadata`).
- **Pi-package `expert_status` now defaults to the bounded `summary` view.** In 0.7.9 the MCP server defaulted `view` to `summary`, but the Pi package passed an omitted `view` straight through as `undefined`, so the core fell back to the full legacy payload — every `expert_status` call from a Pi Main Agent dumped all executions' attempt histories, telemetry, and the entire model assessment, the exact context cost the views feature exists to prevent. The Pi package now defaults to `summary` (explicit `full`/`running` still honored), matching the MCP server.

## 0.7.10（中文）

### 修复

- **`timeoutMs` 执行字段导致的状态重载损坏（0.7.9 回归）**：0.7.9 为状态视图的剩余时间新增了 `ExecutionStateSnapshot.timeoutMs`，却没同步进严格的持久化执行 schema——于是任何运行过的执行都写入了加载器拒绝的 `timeoutMs`，宿主重启或新进程里整个 `state.json` 不可读（"Unrecognized key: timeoutMs"）。现在该字段已入 schema，且执行快照改用 `passthrough()`，未来再给执行快照加可选字段时 schema 滞后再也不能卡死整个 state（与 `executionMetadata` 已有的前向兼容保证一致）。
- **Pi 包 `expert_status` 现默认有界 `summary` 视图**。0.7.9 中 MCP 端把 `view` 默认设为 `summary`，但 Pi 包把省略的 `view` 原样传成 `undefined`，core 于是回落全量旧负载——Pi 主代理每次 `expert_status` 都会打出全部执行的 attemptHistory、遥测与整份模型评估，正是视图功能要消除的上下文开销。现在 Pi 包默认 `summary`（显式 `full`/`running` 仍生效），与 MCP 端一致。

## 0.7.9 - 2026-09-11

### Added

- **`expert_availability_reset`**: clear runtime availability markers by scope — `*` (every model), a bare provider (all its models), or an exact `provider/id` key — in memory and the persisted shared assessment together. Use it when a transient failure was misrecorded or a provider recovers before the marker TTL expires; no more hand-editing `model-assessment.json` or restarting the host.
- **`expert_verify`**: run a bounded command on the plugin side inside a retained expert worktree (`executionId`) or a validated `workspace`, returning the real exit code and an output tail. Argv is passed without a shell, the child environment is allowlist-scrubbed, and the run is time-boxed.
- **`expert_status` views**: `view="summary"` (default) returns running executions with `elapsedMs`/`remainingMs`, the last 20 completed executions, and live provider concurrency slots; `view="running"` is only live executions; `view="full"` preserves the legacy payload including telemetry and the model assessment.
- **Richer test evidence**: `tests[]` entries now carry optional `exitCode`, `testsRun`, `failedCount`, `errorCount`, `skippedCount`, `durationMs`, and `outputTail`; the runtime verification gate records `exitCode` and `outputTail` per step, and the expert prompt requires a command plus exit code for any test claimed to have run.

### Fixed

- **Failure results keep artifacts**: timed-out, session-error, and thrown-error expert results now include `filesChanged` (from the retained worktree) and the last assistant text, so a 30-minute timeout no longer returns an empty result and already-written work is discoverable without manually inspecting the worktree.
- **State write-side clamp**: `clampExpertResult` truncates oversized arrays and text at the single persistence choke point, and `unavailableModels`' bound rose from 8 to 64. A verbose expert can no longer write a state file that fails to reload and breaks the council tools until a restart (the class of bug behind the v0.7.7/v0.7.8 regressions).
- **`resetAvailability("*")` full-clear**: clearing every marker now actually removes the `modelAvailability`/`modelStatus` maps instead of leaving the originals in place.
- **Routing-drift noise**: the "built against a different model inventory" note now fires only when the delegation actually selects a different model than the plan (naming both), instead of on every delegation after any inventory change.

### Changed

- **Completion-notification reliability**: the Pi package retries the completion message briefly when the idle/streaming race or a mid-transition session rejects the first send, reducing silently-lost notifications.

## 0.7.9（中文）

### 新增

- **`expert_availability_reset`**：按作用域即时清除运行时可用性标记——`*`（全部）、裸供应商名（该供应商全部模型）、或精确 `provider/id`；内存与持久化共享评估一并更新。误标或供应商在 TTL 前恢复时使用，无需手改 `model-assessment.json` 或重启宿主。
- **`expert_verify`**：插件侧在保留的专家 worktree（`executionId`）或受校验 `workspace` 内运行有界命令，返回真实退出码与输出尾部；argv 不经 shell、子进程环境白名单化、限时。
- **`expert_status` 视图**：`view="summary"`（默认）返回运行中执行（含 `elapsedMs`/`remainingMs`）、最近 20 条完成、供应商并发槽；`view="running"` 仅运行中；`view="full"` 保留含遥测与模型评估的旧全量。
- **测试证据强化**：`tests[]` 新增可选 `exitCode`/`testsRun`/`failedCount`/`errorCount`/`skippedCount`/`durationMs`/`outputTail`；验证门每步记录 `exitCode` 与 `outputTail`；专家 prompt 要求任何声称已运行的测试必须带命令与退出码。

### 修复

- **失败结果保留产物**：超时、会话错误、抛错失败的专家结果现在附带 `filesChanged`（取自保留的 worktree）与最后助手输出——30 分钟超时不再返回空结果，已写成果无需手动翻 worktree 即可发现。
- **持久化写侧钳制**：`clampExpertResult` 在唯一持久化入口截断超长数组与文本，`unavailableModels` 上限 8→64；啰嗦的专家再也不能写出重载失败、把理事会工具卡到重启的 state 文件（v0.7.7/v0.7.8 那类回归的根因）。
- **`resetAvailability("*")` 全量清除**：清除全部标记时真正删除 `modelAvailability`/`modelStatus` 映射，不再保留原始条目。
- **路由漂移噪声**："built against a different model inventory" 提示仅在实际选出与计划不同的模型时触发（并点名两个模型），不再因任何库存变化就在每次委派上刷屏。

### 变更

- **完成通知可靠性**：Pi 扩展在 idle/streaming 竞态或会话切换首投被拒时短暂重试完成消息，减少静默丢失。

## 0.7.8 - 2026-09-10

### Fixed

- **State forward compatibility (0.7.7 regression)**: the persisted-state schema rejected `results.*.result.executionMetadata.stoppedByExpert` as an unknown key, so a state file written by 0.7.7 (any `report_and_stop` result) made the entire council state unreadable after a host restart. The schema now accepts the field, and `executionMetadata` is parsed with `passthrough()` so a schema lag on a future metadata field can never again render the whole state unreadable. Strictness is preserved on the top-level result shape.

### Changed

- **Host shutdown now persists terminal results**: `session_shutdown` previously relied on the delegation promise chain to write aborted results — a promise chain that may never resume while the process is exiting, leaving `running` records for dead experts. A new `ExpertCouncil.shutdownAll` aborts every running execution, writes its terminal `aborted` result, awaits the state flush, and only then returns; the extension uses it during teardown. If the process actually survives, a real late result still overwrites the placeholder.

## 0.7.8（中文）

### 修复

- **状态前向兼容（0.7.7 回归）**：持久化 state 的 schema 将 `executionMetadata.stoppedByExpert` 判为未知键——0.7.7 写过 `report_and_stop` 结果的 state 文件在宿主重启后**整体不可读**。现在 schema 接受该字段，且 `executionMetadata` 改为 `passthrough()` 解析：未来再给元数据加字段时，schema 滞后不会再次让整个 state 报废。顶层 result 形状仍保持严格。

### 变更

- **宿主关闭现在会落盘终局结果**：此前 `session_shutdown` 依赖委派 promise 链写 aborted 结果——而进程退出时该链可能永远不恢复，给死掉的专家留下 `running` 记录。新增 `ExpertCouncil.shutdownAll`：中止所有运行中执行、写入终局 `aborted` 结果、等待 state 刷盘后才返回；扩展在 teardown 时使用它。若进程实际存活，真实迟到结果仍会覆盖占位结果。

## 0.7.7 - 2026-09-10

### Added

- **`report_and_stop` expert tool**: every expert session receives a built-in tool for deterministically ending a task it cannot complete (missing tool, absent environment, denied permission, unreachable goal). The call delivers a structured report — exact blocker, findings, risks, `recommendedNextAction` — as a `partial` result with `failureType: missing_context` and `stoppedByExpert: true`, aborts the session, and terminates the delegation loop without retry or escalation. The mutation worktree stays intact for inspection, and the prompt now instructs experts to use it instead of burning the budget on silent workarounds.
- **Host-bound expert lifetime** (`security.expertLifetime`, default `host-bound`): the Pi package extension now subscribes to `session_shutdown` and aborts all running expert executions when the host session quits or is replaced (new/resume/fork), so experts never outlive the conversation burning quota with no receiver for their results; their persisted state records the abort for a later `expert_result` lookup. Set `expertLifetime: "detached"` to restore the old orphaned-run behavior.

## 0.7.6 - 2026-09-10

### Fixed

- **Transient throttling no longer blackholes a token plan**: DashScope-style TPM/RPM throttling (`Allocated quota exceeded ... #token-limit`, `Throttling`, `rate limit`, `too many requests`) was misclassified as plan-quota exhaustion, marking every sibling model `quota-exhausted` for up to 6 hours and pushing routing to more expensive metered providers. Provider throttling evidence is now classified as a distinct `rate-limited` marker kind with a **2-minute** TTL (still provider-wide, since account-level TPM applies to all siblings), while genuine plan-cycle exhaustion (`... quota has been exhausted`, `insufficient_quota`, arrears wording) keeps the 6-hour `quota-exhausted` marker. Availability warnings and persisted `modelStatus` now report `rate-limited` explicitly.

## 0.7.5 - 2026-09-09

### Breaking

- `reasoningLevel` is now a required argument on every expert delegation (service, MCP schema, Pi package, CLI), mirroring `timeoutMs`: the Main Agent must choose it deliberately from the task and model (planning/architecture usually `high`; cheap flash executors tolerate `high` while expensive full-size executors fit `medium`; exploration and verification usually `low`).

### Added

- **Composition-pinned reasoning levels**: `council-compositions.json` pool entries accept either a bare `"provider/id"` string or `{ "model": "provider/id", "reasoningLevel": "high" }`. A pinned level overrides the host's argument and the model profile — the roster is the deliberate choice. Bare entries keep requiring the host's explicit level.

### Fixed

- **Python/.venv expert tasks**: provisioning previously skipped Python ecosystems with a bare "unsupported" note, so experts had no way to reach the host's virtualenv. `uv.lock` projects now provision with `uv sync --frozen`; other Python ecosystems (pyproject.toml/requirements.txt/setup.py) surface the host workspace's `.venv` interpreter absolute path in the expert prompt, so the expert can invoke it directly instead of guessing (verified working in live testing).

## 0.7.4 - 2026-09-09

### Added

- **Optional-by-default operator config**: `council-config.json` is now discovered in the shared data directory without any environment variable — present it is read, absent everything stays at the defaults. An explicit `configPath` option or `EXPERT_COUNCIL_CONFIG` still takes precedence (and must exist). `expert_inspect` surfaces the file location and the effective provisioning mode under `operatorConfig` so the Main Agent can edit it on the user's behalf; changes apply after the host session restarts.

## 0.7.3 - 2026-09-09

### Fixed

- **Abort during workspace preparation**: the execution entry is now pre-registered before worktree creation and provisioning, so an `expert_abort` arriving during those (potentially minutes-long) phases is honored after setup instead of answered `not-found`. Progress snapshots and abort are safe against the not-yet-created session.
- **Windows long-path cleanup**: `git worktree remove --force` cannot delete provisioned worktrees whose nested node_modules exceed Windows MAX_PATH ("Filename too long"). Cleanup now falls back to a libuv long-path recursive removal followed by `git worktree prune`.

## 0.7.2 - 2026-09-09

### Fixed

- **Windows provisioning**: npm/pnpm resolve through `.cmd` shims that `execFile` cannot launch (and modern Node refuses `.cmd` children without a shell) — provisioning failed with `spawn npm ENOENT` on Windows. The platform runner now routes npm/pnpm/yarn through `.cmd` + shell.
- **Persisted-state restore**: plans saved by 0.7.1 with the new `composition`/`compositionMenu` fields were rejected on restore by the strict state schema (`Unrecognized key`), breaking every subsequent delegation in an existing session. Both fields are now accepted.

## 0.7.1 - 2026-09-09

### Added

- **Runtime worktree auto-provisioning** (opt-in via `security.workspaceProvisioning.mode`, default `"none"`): when a mutation expert is dispatched, the runtime detects the repository lockfile (pnpm/npm/bun) and installs pinned dependencies inside the fresh worktree with `--ignore-scripts` and an allowlist-scrubbed child environment. Worktrees are reused per execution id (clean-slate `git reset --hard` + `git clean` on retry) and provisioning is serialized by a semaphore; failures degrade to the previous behavior instead of aborting the delegation. Worktree-removal timeouts are configurable (`removalTimeoutMs`, default 300s) since deleting a provisioned tree is slow.
- **Runtime verification gate**: after a provisioned mutation expert finishes, the runtime runs the repository's typecheck then tests (configurable via `verifyCommand`). Failures downgrade a `"success"` result to `"partial"` with failureType `test_failure`, engaging the existing corrected-retry escalation at zero Main Agent cost. Retry guidance (`correctedInstruction`) is now actually delivered to retried attempts — it was generated but never consumed.

### Fixed

- `preferredReasoningByRole` accepted only full-role maps: `z.record(z.enum(...))` requires every key under zod 4; the profile contract is partial, so it now uses `z.partialRecord` (same trap previously fixed in compositions).
- Integration contract: hosts must integrate worktree results from `filesChanged` (which already includes untracked new files), never from `git diff HEAD` alone — codified in SKILL.md and the `expert_result`/`expert_cleanup` tool descriptions.

## 0.7.0 - 2026-09-09

### Breaking

- Billing profiles replace the `marginalCostClass` tier with a numeric `costMultiplier` (0.01–100, default 1.0): a relative token-consumption weight used for cost scoring and cap accounting. Legacy tiers map deterministically on load (very-low→0.1, low→0.5, normal→1.0, high→3.0, scarce→5.0); `usagePreference` is removed entirely.
- The build-first question is no longer only economy/balanced/speed: `expert_build` without parameters returns a composition menu (up to 3 saved compositions + an auto option) when compositions are wired.

### Added

- **Provider token caps**: per-provider `dailyTokenCap` (default 20M) and `weeklyTokenCap` (default 150M) in `route-policy.json`'s `providers` map. Weighted consumption (expert usage tokens × the model's `costMultiplier`, cache excluded) accumulates in a persisted `usage-ledger.json` after every expert attempt. Breaching a cap marks the provider's models quota-exhausted until the UTC reset boundary (next midnight / next Monday).
- **Provider concurrency limits**: `maxConcurrency` per provider (default 0 = unlimited); delegation excludes providers whose in-flight expert count has reached the limit.
- **Persistent council compositions**: `council-compositions.json` in the shared data directory stores named role→models rosters (multiple models per role allowed). Sessions bind to a composition (30-day pruning, resume-stable); routing stays inside the bound pools with route-policy deny always winning. `expert_delegate` accepts an optional per-assignment `model` pin from the role's pool, enabling single or concurrent multi-model dispatch. Agents create/modify compositions by editing the file (path surfaced via `expert_inspect`).
- README sections for daily/weekly caps, route-policy allow/deny, billing multipliers, and council compositions.

## 0.6.1 - 2026-09-09

### Fixed

- HTTP 429 / plan-quota exhaustion (including `insufficient_quota` and Chinese arrears wording) is now classified as `provider_error` instead of `unknown`, so the existing provider-wide quota-exhausted marker actually lands: one depleted weekly quota stops routing into every model of that token plan for the marker lifetime instead of burning attempts until the quota resets. (Missed the 0.6.0 publish — the fix landed after the tarball was cut.)

## 0.6.0 - 2026-09-09

### Breaking

- `timeoutMs` is now a required argument on every expert delegation (service, MCP schema, Pi package, CLI). Omitting it throws instead of falling back to a silent default. A timed-out attempt automatically scales the next attempt's budget by 1.5× (capped at 3,600,000 ms).
- Experts are instructed to stop immediately with a structured `missing_context`/`permission_error` result when a task is impossible with their assigned tools, and the delegation loop terminates on those failure types instead of retrying or escalating — the result (with `recommendedNextAction`) reaches the Main Agent in real time through the existing steer/followUp channel.
- Billing assessments accept up to 128 entries so per-model (`provider/id`) classes fit larger inventories.

## 0.5.6 - 2026-09-07

### Added

- Quota-aware per-model billing: subscription token plans carry periodic quotas with per-model burn rates, so billing entries may now use `provider/id` keys (in `model-assessment.json` billing, user configuration, and submitted assessments) to override the provider-level cost class per model. Routing checks the explicit `billingProfile` first, then the model-level entry, then the provider-level default. The assessment gate instructs the Main Agent to classify subscription plans per model, and `expert_inspect` warns when a subscription provider with five or more models still relies on one blanket provider-level class.
- File-driven route policy: model allow/deny lists now live in `route-policy.json` next to `model-assessment.json` in the shared state directory — no dedicated tool. The file holds a `system` entry every session obeys plus persisted per-session entries keyed by the host conversation (Pi session IDs survive resume; MCP stdio conversations use a stable `"default"` key). Sessions may only narrow the system policy: deny lists union, allow lists intersect, and deny always wins. Entries are `provider/id` or a bare `provider` for a whole provider. `expert_inspect` returns the conversation's `sessionKey`, the `effective` policy, and the file's `sourcePath` so hosts can edit it directly; changes apply on the next expert call, stale session entries are pruned after 30 days, and a corrupt file is ignored with a warning.
- Provider-wide quota marking: quota and balance exhaustion is a provider-account fact, so one model failing with quota evidence marks every sibling model of the same provider, and the current delegation immediately stops considering that provider's remaining candidates instead of burning an attempt per sibling model.

### Changed

- `expert_inspect` now always returns a `routePolicy` view (`sessionKey`, `effective`, optional `system`/`session` entries and `sourcePath`).

## 0.5.5 - 2026-09-07

### Added

- Main-Agent abort control: the new `expert_abort` tool (MCP, Pi package, and CLI) deliberately stops a running expert whose direction no longer matches expectations. Aborted attempts are marked `aborted`, never retried or escalated, completed work such as a mutation worktree stays preserved until `expert_cleanup`, and the response returns a bounded progress snapshot (last assistant output, elapsed time, files changed so far) that doubles as the handoff brief for a follow-up delegation. `expert_result` accepts `includeProgress` to inspect in-progress work before deciding.
- Per-model runtime status: `model-assessment.json` now records a `modelStatus` map (`available`, `quota-exhausted`, or `unavailable`) updated on every observed outcome, so the current state is readable at a glance instead of being reconstructable only from telemetry.
- Distinct quota-exhausted model state: provider failures indicating an exhausted plan or API balance (insufficient quota, arrears, unpaid balance) are marked with a `quota-exhausted` kind and a shorter marker lifetime than dead models, and inspection warnings explain the top-up-or-wait semantics.

### Changed

- `model-assessment.json` is now written as structured multi-line JSON instead of a single flat line.

## 0.5.4 - 2026-09-05

### Changed

- The Codex plugin now bundles the tested Pi SDK 0.85.1 runtime (previously 0.84.4), matching current Pi releases; the bundled runtime remains fully self-contained and reports its SDK version through runtime capabilities.
- `@expert-council/pi-package` metadata now carries discovery keywords (`council`, `pi-extension`, `multi-agent`, and related terms) and a searchable description so the package surfaces in npm and pi.dev package searches.

### Notes

- Pi 0.85.1 fixed the 0.85.0 SDK import regression upstream (internal experimental code is no longer published in the SDK main entry). The 0.5.3 actionable `pi-server` diagnostic remains useful only for installations still pinned to 0.85.0.

## 0.5.3 - 2026-09-05

### Fixed

- `loadPiSdk` now recognizes the Pi 0.85+ packaging change — the coding-agent SDK main entry statically imports the separate `@earendil-works/pi-server` package without declaring it as a dependency — and returns an actionable instruction (`npm install -g @earendil-works/pi-server`) instead of a bare module-not-found error. This restores the npm-installed Pi Package, the CLI, and every non-bundled SDK path against Pi 0.85.0.
- Version alignment: npm packages, the Git marketplace plugin, and the release tag share one version line again after 0.5.2 shipped only through the Git marketplace.

## 0.5.2 - 2026-09-05

### Fixed

- The Git Marketplace Codex plugin now bundles its tested Pi SDK runtime instead of resolving it from the user's global npm directory. A direct install therefore works even when the globally installed Pi package has missing or incompatible transitive modules.
- The installed-plugin smoke test now hides global npm module paths, parses the `expert_inspect` response, and rejects SDK diagnostics instead of treating any text content block as success.
- Installation documentation now pins `v0.5.2` and explicitly distinguishes the required Pi account/model configuration from the no-longer-required global SDK module.

## 0.5.1 - 2026-09-05

### Fixed

- Git tags now include the prebuilt Codex plugin server and shared role prompts, so a pinned remote Git marketplace can install the plugin without cloning the repository or running a local build.
- Added the repository marketplace catalog and complete Codex CLI installation, verification, upgrade, and removal instructions.

## 0.5.0 - 2026-09-04

### Added

- Codex workspace discovery through the host-owned `codex/sandbox-state-meta` experimental capability, replacing the bundled PreToolUse hook: the server derives the sandbox working directory from Codex metadata with no hook approval or manual setup, falling back to MCP roots and `EXPERT_COUNCIL_WORKSPACE`.
- Cost-policy guidance: when `constraints.costPolicy` is omitted, `expert_build` returns a reminder to establish exactly one policy with the user (economy, balanced, or speed) and reuse it for the conversation; the tool description and shared Skill document the requirement.
- Session-scoped cost-policy enforcement for the delegation path: a stdio server tracks whether the conversation established a cost policy, and until then every `expert_delegate` response carries the ask-the-user reminder, closing the bypass where hosts dispatched without `expert_build`.
- Engagement guidance in the `expert_delegate` description (prefer delegation over inline multi-file work, call `expert_build` first for substantial tasks) and a trigger-rich shared Skill description that engages the council on substantial work in every conversation turn, not only when it is named explicitly.
- The Codex plugin is now functionally tested and officially documented: the README replaces the earlier not-yet-released notice with marketplace installation, verification, behavior, and removal guidance.
- Workspace-aware mutation capability: writable delegations evaluate mutation for the requested `workspace` instead of the startup directory, so a Git repository subfolder inside the trusted boundary is usable even when the conversation folder itself is not a repository; failure guidance now directs the host to retry with the project's repository root.

### Fixed

- The availability-marker inspection test no longer decays after 24 real hours of wall-clock time.

## 0.4.0 - 2026-09-03

### Added

- Runtime availability markers: a delegated `provider_error` with dead-model evidence (for example `model_not_found`, unknown/discontinued models, model-access denials such as `AccessDenied.Unpurchased`, or the runtime's own availability pre-check) records a `modelAvailability` marker in the persisted shared model assessment through an atomic read-modify-write that never reverts a newer snapshot from another running Pi/Codex instance.
- `expert_result` now names models marked unavailable during the execution in `executionMetadata.unavailableModels` and `risks`, so the Main Agent learns that a model can no longer be called even when escalation succeeds.
- `expert_inspect` warns about active availability markers, and routing hard-rejects marked models in `expert_build`, delegation, and escalation.
- Concurrent Pi/Codex service instances re-read the shared model assessment before inspection, council building, delegation, and escalation, so a marker written by one instance is observed by the others without a host restart.
- Explicit `modelOverrides["provider/model"].overrideUnavailableMarker: true` re-enables a marked model; markers expire after 24 hours, are preserved across fresh submitted audits, and transient failures (rate limits, auth errors) never create markers.

### Fixed

- Pi sessions surface upstream provider failures as a final assistant message with `stopReason: "error"` and a diagnostic in `errorMessage`; the runtime previously swallowed those diagnostics and returned a vague empty-response `partial` result with a `reasoning_failure` classification. Session errors now return a failed result carrying the real provider message and failure class.
- The durable council-state schema accepts the new `unavailableModels` result metadata, keeping state files written by a build that already reports marked models loadable.
- Structured expert output is extracted with balanced-brace scanning instead of the greedy first-to-last brace span, so prose containing malformed brace fragments can no longer break result parsing (security review M1).
- Worktree retention derives age from the creation epoch embedded in the generated worktree directory name instead of directory mtime, which is unreliable on Windows (security review m4).
- `.gitignore` covers the whole workspace-local `.expert-council/` directory instead of listing individual files (security review m5).
- The installed-plugin smoke test gives the workspace-hook subprocess a 15-second kill timeout (security review m6).

### Reviewed

- Security review outcomes recorded without code changes: MCP `withMcpTimeout` intentionally does not cancel the underlying operation (hosts keep their own deadlines); `PI_CODING_AGENT_MODULE` remains an explicitly trusted operator input documented in SECURITY.md without signature verification, which would break the documented local-development resolution order; remaining silent-fallback paths carry explicit best-effort comments; pinned devDependency ranges rely on `package-lock.json` and `npm ci` for reproducibility.

### Changed

- Pi package README model-discovery guidance documents that Pi's cached inventory can contain stale model names and how availability markers mitigate it.

## 0.3.0 - 2026-09-02

### Added

- Event-driven `expert_wait` for Codex and generic MCP hosts, supporting bounded `any` or `all` completion waits over up to eight execution IDs without status polling.
- Explicit difficulty-based execution and wait timeout guidance for Main Agents and shell-capable experts.
- A mandatory, freshness-checked model-assessment gate that blocks council construction and delegation until every callable model has a current dated, sourced assessment.
- Runtime billing evidence and provenance in resource inspection, separating named Token Plan access from providers with non-zero metered catalog prices.

### Changed

- Raised the bundled Codex MCP transport safety ceiling to 3660 seconds while retaining operation-specific execution and wait deadlines.
- Clarified the host workflow: dispatch immediately, continue independent Main Agent work, then block intentionally in `expert_wait` instead of ending the Codex turn or polling.
- Split host completion guidance into build-composed Pi and Codex overlays, keeping `expert_wait` out of the native Pi Skill while retaining one platform-neutral source of shared guidance.
- Moved local data out of project workspaces, with shared per-user capability assessments and reliability telemetry plus per-workspace execution state. Windows, Linux, and macOS use platform-appropriate user data roots; legacy project-local data is left untouched for explicit migration or removal.
- Report future-dated model assessments separately, preserve their evidence during timestamp correction, and expose the 12-source bound in host guidance.
- Prevent ordinary workspace-state writes from overwriting a newer global model assessment held by another Pi/Codex service instance.
- Reuse a current persisted model assessment when a host submits an incomplete, stale, or future-dated replacement; empty Pi assessment arguments are discarded before validation instead of triggering a false full-inventory re-audit.
- Centralize failure classification and model-assessment schemas in Core, record Pi Skill discovery degradation, and keep billing scores finite for malformed numeric input.
- Make `expert_cleanup` remove every retry/escalation worktree associated with an execution instead of stopping after the first match.
- Document shell-safe local Pi install/remove commands and the complete candidate-package verification lifecycle; Windows paths passed through Pi's Bash-compatible shell now use forward slashes or resolved quoted paths.

## 0.2.0 - 2026-09-01

### Added

- Non-blocking native Pi batch delegation with completion steering/follow-up notifications and explicit result retrieval.
- Conversation-scoped economy, balanced, or speed council preference.
- Dated, sourced Main Agent model assessments with durable reuse and explicit user billing precedence.
- Compact default host presentations with opt-in full inventory and council detail.
- Per-attempt durable execution diagnostics, stricter state validation, and local recovery behavior.
- Dirty source-workspace warnings for detached mutation worktrees.

### Changed

- Improved constrained council composition so execution-critical roles survive small `maxExperts` limits.
- Hardened Pi resource isolation, Skill trust handling, worktree lifecycle, local state, telemetry storage, paths, and structured output bounds.
- Tightened CLI, MCP, and Pi tool input validation while preserving the original single-assignment delegation shape.
- Added compatibility repair for models that stringify Pi batch `assignments` arrays.

### Verified

- Qwen and GLM batch-delegation regression tests completed successfully.
- Deterministic build, test, typecheck, package dry-run, MCP smoke, and Codex bundle smoke checks pass without paid-model calls.
