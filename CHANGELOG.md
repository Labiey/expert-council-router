# Changelog

All notable changes to Expert Council are documented here. Versions follow semantic versioning: major releases contain breaking changes, minor releases add backward-compatible functionality, and patch releases contain backward-compatible fixes.

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
