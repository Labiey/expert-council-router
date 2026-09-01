# Security Policy

## Execution boundaries

Read-only roles receive a hard Pi tool allowlist without `edit`, `write`, `bash`, or `powershell`. Mutation roles default to detached Git worktrees created under a current-user-specific private temporary directory. The runtime validates the base path, ownership and permissions where the operating system exposes them, canonical containment, and the new worktree's Git registration before use. The worktree is retained so the Main Agent can inspect and integrate it, then must be removed with `expert_cleanup`. Unclaimed Expert Council worktrees expire after `security.worktreeRetentionMs` (24 hours by default) and are pruned before later mutation runs. If isolation cannot be created, mutation fails unless the user explicitly enables `security.allowInPlaceMutations` with `workspaceStrategy: "bounded-in-place"`.

All requested workspaces are canonicalized and must fall under `security.allowedWorkspaceRoots`. When the list is empty, only the runtime's startup workspace is allowed.

Expert sessions receive only role tools and already-installed, enabled Skills. The Pi resource loader always disables extensions, prompt templates, themes, and project context files. User-scope Skills are trusted; project/temporary Skills require an exact `security.trustedSkills` allowlist entry. Expert Council fails closed when the installed Pi SDK lacks the required project-trust or resource-suppression APIs. Expert prompts prohibit recursive delegation. Third-party executable packages are never installed by Expert Council.

Mutation roles retain shell access because they must edit and test; that shell runs in the isolated worktree unless the operator explicitly opts into bounded in-place mutation. `bounded-in-place` therefore has a materially weaker security boundary and must not be enabled for untrusted assignments.

## Trusted startup inputs

Process environment and CLI path flags are administrative inputs, not model-controlled configuration. `PI_CODING_AGENT_MODULE` points to executable Pi SDK code. `EXPERT_COUNCIL_CONFIG`, `EXPERT_COUNCIL_WORKSPACE`, `EXPERT_COUNCIL_TELEMETRY`, `EXPERT_COUNCIL_STATE`, and their CLI equivalents select local files or directories. Do not populate them from repository content, delegated task text, or expert output. The Codex distribution passes its bundled role directory directly to the runtime rather than accepting a role-prompt directory environment override.

## Data handling

Telemetry is local JSONL. It records only opaque execution IDs, bounded outcome fields, Main Agent verification outcomes, and optional token/cost estimates exposed by Pi. It does not record prompts, source text, credentials, API keys, or private reasoning. Repeated rows for one execution are reduced to the latest outcome during aggregation. `.expert-council/telemetry.jsonl` is ignored by Git and npm packaging.

Durable recovery state is stored in `.expert-council/state.json`, which is also ignored by Git and npm packaging. Unlike telemetry, recovery state contains bounded council tasks and structured expert results so plans and completed work survive process restart. Every nested plan, execution, attempt, and result is schema-validated before restoration. Treat this file as project-private data. A task that was running during a restart is recorded as interrupted and is never silently resumed.

The runtime reads Pi's existing credential store through Pi APIs. Expert Council does not copy credentials into its config or telemetry.

## Reporting

Do not open a public issue containing credentials, private prompts, or source code from a confidential repository. Report the smallest reproducible security boundary failure to the project maintainers through the repository's private security-reporting channel once one is configured.
