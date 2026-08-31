# Security Policy

## Execution boundaries

Read-only roles receive a hard Pi tool allowlist without `edit` or `write`. Mutation roles default to detached Git worktrees created under the operating system's temporary directory. The worktree is retained so the Main Agent can inspect and integrate it, then must be removed with `expert_cleanup`. Unclaimed Expert Council worktrees expire after `security.worktreeRetentionMs` (24 hours by default) and are pruned before later mutation runs. If isolation cannot be created, mutation fails unless the user explicitly enables `security.allowInPlaceMutations` with `workspaceStrategy: "bounded-in-place"`.

All requested workspaces are canonicalized and must fall under `security.allowedWorkspaceRoots`. When the list is empty, only the runtime's startup workspace is allowed.

Expert sessions receive only role tools and already-installed, enabled Skills. Expert prompts prohibit recursive delegation. Third-party executable packages are never installed by Expert Council.

## Data handling

Telemetry is local JSONL. It records only outcome aggregates and optional token counts. It does not record prompts, source text, credentials, API keys, or private reasoning. `.expert-council/telemetry.jsonl` is ignored by Git and npm packaging.

Durable recovery state is stored in `.expert-council/state.json`, which is also ignored by Git and npm packaging. Unlike telemetry, recovery state contains bounded council tasks and structured expert results so plans and completed work survive process restart. Treat this file as project-private data. A task that was running during a restart is recorded as interrupted and is never silently resumed.

The runtime reads Pi's existing credential store through Pi APIs. Expert Council does not copy credentials into its config or telemetry.

## Reporting

Do not open a public issue containing credentials, private prompts, or source code from a confidential repository. Report the smallest reproducible security boundary failure to the project maintainers through the repository's private security-reporting channel once one is configured.
