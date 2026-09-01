# Changelog

All notable changes to Expert Council are documented here. Versions follow semantic versioning: major releases contain breaking changes, minor releases add backward-compatible functionality, and patch releases contain backward-compatible fixes.

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
