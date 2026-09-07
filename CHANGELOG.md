# Changelog

All notable changes to Expert Council are documented here. Versions follow semantic versioning: major releases contain breaking changes, minor releases add backward-compatible functionality, and patch releases contain backward-compatible fixes.

## Unreleased

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
