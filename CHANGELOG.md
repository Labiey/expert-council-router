# Changelog

All notable changes to Expert Council are documented here. Versions follow semantic versioning: major releases contain breaking changes, minor releases add backward-compatible functionality, and patch releases contain backward-compatible fixes.

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
