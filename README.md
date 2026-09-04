# Expert Council

[English](README.md) | [简体中文](README.zh-CN.md)

Expert Council is a local, multi-model, cost-aware expert orchestration system for Pi and MCP hosts such as Codex. It discovers the models connected through Pi's registered LLM APIs and coding plans, combines runtime metadata with user-defined billing policy, capability profiles, and local reliability data, dynamically assembles a small semantic expert team, executes bounded tasks through Pi, and returns compact structured results to the Main Agent.

Key advantages:

| Advantage | Description |
|---|---|
| Cost savings | Makes flexible use of subscribed plans and LLM APIs, automatically matching the most suitable model to each task's difficulty |
| Speed | Runs multiple suitable models concurrently, accelerating repository exploration and context compression |
| Safer | Assigns different read-only/writable permissions per expert; writable experts commit into an isolated Git worktree that the Main Agent reviews before integration |
| Context savings | The Main Agent no longer carries long tool-call-heavy context; it receives summarized, structured results from experts |

In practice, the theoretically strongest model is not automatically the best executor. A model with stable tool calls, reliable shell behavior, and low marginal cost can deliver more real task value than a stronger but less dependable one. We recommend configuring a cost-effective, execution-strong model as the Main Agent; when a complex problem appears, Expert Council can dispatch strong-reasoning models for review or planning.

## Current status

The current release (0.5.1) includes:

- A host-independent Core: configuration validation, model normalization, billing policy, profile layering, role scoring, task classification, dynamic team sizing, retry/escalation, and telemetry aggregation.
- An execution runtime built on Pi's current `ModelRuntime` and `createAgentSession` APIs.
- Hard tool allowlists and installed-Skill filtering for every expert session.
- Isolated Git worktrees for writable experts.
- A JSON-capable CLI.
- An MCP Server with nine asynchronous semantic tools, event-driven completion waits, an acceptance-feedback loop, and explicit worktree cleanup.
- A native Pi Package.
- Runtime availability markers: when a call fails with dead-model evidence, the model is recorded into the persisted assessment and hard-rejected by later council building, delegation, and escalation; markers expire and are retried automatically after 24 hours.
- Provider session error surfacing: upstream denials such as `403 AccessDenied` are no longer swallowed; they return to the Main Agent with the real diagnostic and the correct failure class.
- Cross-process shared model assessment: with multiple instances running in parallel, availability markers become visible to each other without a restart.
- A Codex plugin with the shared Skill and a bundled stdio MCP Server, using Codex's host-owned `codex/sandbox-state-meta` capability for workspace discovery (no hooks).
- Deterministic automated tests that never consume model quota.

## Architecture

```text
Codex or Pi Main Agent
        |
        | semantic tools / shared Skill
        v
 Expert Council Core
 - resource and model normalization
 - billing and capability profiles
 - deterministic routing
 - roles and team sizing
 - retry and escalation
 - telemetry aggregation
        |
        v
     Pi Runtime
 - callable model discovery
 - hard tool allowlists
 - installed-Skill filtering
 - bounded expert sessions
 - workspace isolation
     /     |      \
   CLI  Pi Package  MCP Server
                        |
                   Codex plugin
```

TypeScript project references enforce that dependencies flow only in these directions:

```text
core <- pi-runtime <- cli
                   <- mcp-server <- codex-integration
                   <- pi-package
```

Core does not import Pi, Codex, MCP transport, filesystem, shell, or process APIs. The CLI, MCP Server, and host distributions all use the same service and routing logic.

## Quick start

Requirements:

- Node.js 22.19 or later.
- npm 11 or a compatible version.
- Pi installed and configured with at least one usable model.
- When writable experts need worktree isolation, the Git repository must have at least one commit.

### Install the Pi Package

Install from npm (recommended):

```bash
pi install npm:@expert-council/pi-package
pi list
pi --verbose
```

`pi list` should show `npm:@expert-council/pi-package` and its resolved directory; a newly started verbose Pi session should load `dist/extension.js`, the `expert-council` Skill, and the eight semantic tools. To upgrade later:

```bash
pi update npm:@expert-council/pi-package
```

### Install the Codex plugin (optional)

To run Codex as the Main Agent, build the repository and install the bundled plugin through a Codex plugin marketplace — see [Codex plugin](#codex-plugin) for the full walkthrough.

### Build from source (development)

```bash
npm install
npm run build
npm test
```

Discover models without calling any of them:

```bash
node packages/cli/dist/bin.js models --json
node packages/cli/dist/bin.js inspect --json
```

Assemble an expert team without executing any expert:

```bash
node packages/cli/dist/bin.js build "fix the device hot-swap race condition" --max-experts 4 --json
```

Delegate only when you are sure actual Pi models should be called:

```bash
node packages/cli/dist/bin.js delegate architecture-oracle "analyze the concurrent invocation path" --workspace /path/to/repo --json
```

Zero configuration uses conservative capability defaults, marks unverifiable billing types as `unknown`, and refuses non-isolated writes. It never guesses that an API is free and never infers model quality from a model name.

## Model discovery

`PiExpertRuntime` calls Pi's `ModelRuntime.getAvailable()` instead of using a hardcoded catalog. A model that merely exists in a registry or user profile is not routed to; only models Pi reports as currently callable are used.

The runtime normalizes:

- provider and model ID;
- display name;
- reasoning support and the reasoning-level map exposed by Pi;
- context and maximum output windows;
- input modalities;
- published API price fields;
- safe compatibility metadata.

The runtime resolves a locally installed compatible Pi SDK first, then an explicit `PI_CODING_AGENT_MODULE` directory, then a compatible global npm Pi installation. If all fail, it returns an actionable diagnostic instead of fabricating a model list.

Pi builds this inventory once per session, and provider catalogs can keep stale model names, so `listAvailableModels()` may include a model the upstream can no longer serve. Routing treats such a model as callable until a real attempt fails; this is why failures with dead-model evidence mark the model unavailable in the persisted model assessment (see the routing section below). Markers expire after 24 hours, and a recovered model is retried automatically.

## Configuration

Specify a configuration file through the `EXPERT_COUNCIL_CONFIG` environment variable or the CLI's `--config PATH` flag. Start from [`config/examples/balanced.example.json`](config/examples/balanced.example.json).

Profile precedence:

```text
built-in conservative defaults
  < user configuration or optional presets
  < current-task runtime overrides
```

Objective runtime metadata is merged separately. Local outcome data influences routing only after at least three samples accumulate, and the adjustment is bounded by `routing.localLearningMaxAdjustment`. Explicit user configuration always wins.

### Billing policy

Supported billing types:

```text
subscription  metered  quota  free  unknown
```

Marginal cost and usage preference are two independent fields because published token prices cannot express subscription plans, fixed quotas, local inference, or promotional credits. The Pi Runtime adapter classifies runtime-reported subscription access or named Token Plan catalogs as `subscription`; otherwise a provider whose Pi model catalog exposes non-zero prices is `metered`, and providers without reliable evidence stay `unknown`. `expert_inspect` returns the inference source, and explicit user configuration always has the highest priority. Models within the same metered provider are still compared on specific prices through `routing.apiPriceWeight` (default `0.35`); an all-zero price table is treated as "not provided", never guessed to be free.

```json
{
  "billing": {
    "providers": {
      "subscription-provider": {
        "billingType": "subscription",
        "marginalCostClass": "very-low",
        "usagePreference": "consume-first"
      },
      "scarce-provider": {
        "billingType": "quota",
        "marginalCostClass": "scarce",
        "usagePreference": "escalation-only"
      }
    }
  }
}
```

`config/examples/` provides:

- `balanced.example.json`: conservative defaults for zero configuration.
- `subscription-heavy.example.json`: prioritize subscription capacity, protect scarce quota.
- `metered-quality.example.json`: separate economical from high-quality metered APIs.
- `qwen-glm.example.json`: explicitly labeled as a hypothetical user preference, not an objective benchmark.

### Capability profiles

Models can receive user scores from 0 to 10 on these dimensions:

```text
reasoning planning architecture coding debugging review longContext
toolReliability bashReliability autonomousExecution speed
```

Model keys must use the exact `provider/model` returned by `models --json`. Newly discovered models without local profiles receive conservative defaults; stale configuration for unavailable models only produces warnings and never crashes routing.

### Main Agent capability audit and first-council preference

Users do not need to maintain per-model usage priorities. After the Main Agent decides a task deserves a council, if this is the first council in a new conversation and the user has not expressed a preference, it should ask once:

```text
price first (economy)
balance price, time, and success rate (balanced)
speed first (speed)
```

The Pi Package records the choice in the current Pi session's hidden extension state; later councils in that conversation reuse it automatically unless the user changes it. `economy` boosts cost weights, `speed` boosts the audited speed dimension, and `balanced` uses normal role weights. The legacy `quality` API value remains compatible but is not offered as a default prompt option.

Model capabilities are audited by the Main Agent rather than hand-ranked by users. `expert_inspect` returns a mandatory assessment gate: if there is no audit yet, the audit is older than 30 days, the callable model set changed, or the user explicitly requests a re-audit, the Main Agent must research every callable model listed by the gate using the host's own web tools; `expert_build` will not assemble a council until then. The Main Agent submits a complete `modelAssessment` whose ISO timestamp must come from the host's real clock, whose sources are consolidated into 1–12 URLs, and which contains 0–10 capability dimensions plus verifiable provider access/billing evidence. Future-dated timestamps are reported separately and can be corrected without repeating the web research. If the gate reports the saved assessment is still `current`, the host should omit `modelAssessment` when calling `expert_build`; incomplete, stale, or future-dated replacement snapshots cannot displace a current one. The assessment is stored once per user data directory and reused across conversations and workspaces as long as the callable model set remains compatible; ordinary plan and execution state saves never overwrite the global assessment from a stale in-memory snapshot, and only an explicitly submitted assessment that passes the gate replaces the stored scores. Explicit user billing configuration always outranks the Main Agent's judgment; unverifiable billing stays `unknown`.

Cross-check rather than trust a single leaderboard: the [Artificial Analysis Data API](https://artificialanalysis.ai/data-api/docs) provides coding, agentic, price, throughput, and latency data; [LiveBench](https://livebench.ai/) covers coding and agentic coding; [Arena](https://arena.ai/leaderboard/text) reflects human preference; provider documentation verifies versions, context, tools, and access method. [OpenRouter Rankings](https://openrouter.ai/rankings?category=programming) mostly reflect real-world usage and are only an adoption signal, not proof of model quality. When the gate demands an audit and the host has no web tools, the Main Agent must state the limitation and stop instead of silently using unaudited defaults; Expert Council never auto-installs plugins, Skills, or third-party executables.

### Role weights

Every semantic role has normalized default weights. Implementation Worker emphasizes tool reliability, coding, autonomous execution, and shell reliability; Architecture Oracle emphasizes architecture, planning, long context, and review.

```json
{
  "routing": {
    "roleWeights": {
      "implementation-worker": {
        "toolReliability": 0.4,
        "coding": 0.3,
        "costEfficiency": 0.1
      }
    }
  }
}
```

Weights are re-normalized automatically. `costPolicy: economy` boosts the cost factor, `speed` boosts speed and reduces cost, and the legacy `quality` reduces cost; none of them bypass safety or compatibility hard constraints.

## Semantic roles and team sizing

Roles are defined by task semantics and never bound to a model name:

| Role | Default permissions | Purpose |
|---|---|---|
| Planner | read-only | Task decomposition, dependencies, and risks |
| Scout | read-only | Repository exploration and context compression |
| Architecture Oracle | read-only | Hard cross-file reasoning and second opinions |
| Implementation Worker | writable | Bounded code changes and focused testing |
| Debugger | writable | Reproduce, isolate, fix, and verify |
| Reviewer | read-only | Regressions, edge cases, and design review |
| Verifier | read-only | Check reported tests, diffs, and acceptance criteria |

Tiny tasks use one Worker; normal tasks use Worker plus Verifier; complex features use Planner, Worker, Reviewer, and Verifier; complex debugging uses Scout, Debugger, Oracle, and Verifier. `maxExperts` caps team size, and the Main Agent is never duplicated as a redundant `lead` expert.

Task classification and all scoring math are deterministic. Hosts can inspect the selected model, alternatives, scores, and concise reasons before delegating. Council assembly also applies configurable diversity penalties; Reviewers prefer a different provider and inferred model family from earlier members when economical, but role fit and hard constraints still dominate.

## Routing pipeline

```text
discover currently callable candidate models
  -> apply hard constraints
  -> merge capability and profile layers
  -> score role fit and effective cost
  -> conservatively apply local outcome adjustments
  -> rank with stable tie-breaking
  -> return selection, alternatives, and reasons
```

Hard constraints reject unavailable or disabled models, incompatible roles, insufficient tool reliability, insufficient context, mutation without runtime support, `escalation-only` resources on routine tasks, and models carrying an active runtime availability marker.

Pi caches its model inventory per session and provider catalogs can keep stale model names, so a council could otherwise be assembled around a model the upstream can no longer serve. When a delegated attempt fails as `provider_error` with dead-model evidence (for example `model_not_found`, unknown or discontinued models, or the runtime's own availability pre-check), the service records a `modelAvailability` marker into the persisted shared model assessment (`EXPERT_COUNCIL_DATA_DIR`, i.e. `%LOCALAPPDATA%/ExpertCouncil/model-assessment.json` on Windows) through an atomic read-modify-write that never reverts a newer snapshot written by another running Pi/Codex instance. The affected `expert_result` names the model in `executionMetadata.unavailableModels` and `risks`, `expert_inspect` warns about active markers, and later `expert_build`, delegation, and escalation hard-reject marked models. Markers are conservative local evidence: they expire after 24 hours, survive freshly submitted audits, and an explicit `modelOverrides["provider/model"].overrideUnavailableMarker: true` re-enables a model. Transient provider failures such as rate limits or authentication errors never create markers. When no saved assessment exists yet, the marker cannot be persisted, but the failure is still reported to the Main Agent and recorded in local telemetry.

Reasoning levels are optional and model-specific. A configured role preference applies only when Pi exposes it for the selected model; otherwise Pi keeps or clamps to the model's supported default.

## Skills and least privilege

The canonical platform-neutral host guidance is [`shared/skills/expert-council/SKILL.md`](shared/skills/expert-council/SKILL.md). The build composes it with the small host overlays under `shared/skills/expert-council/hosts/` into separate Pi and Codex `SKILL.md` artifacts without duplicating the shared workflow. The Pi artifact only describes completion `steer`/`followUp` behavior and never exposes `expert_wait`; only the Codex artifact describes the bounded `expert_wait` flow. Shared role prompts live in `packages/core/src/roles/prompts/` and are copied as package assets rather than rewritten per host.

Read-only roles never receive `edit`, `write`, `bash`, or `powershell`, even if a caller tries to include them. Pi sessions use a real `tools` allowlist, which is stronger than prompt-only guidance. Until a dedicated non-mutating command runner exists, tasks that need shell-driven testing belong to writable roles in isolated worktrees.

Only installed, enabled Pi Skills required by the role are activated. User-scope Skills are trusted by default; project and temporary Skills are excluded unless their exact name is listed in `security.trustedSkills`. Every expert resource loader disables extensions, prompt templates, themes, and project context files, and Pi SDK versions that cannot enforce these policies are rejected. Expert Council never downloads or installs Skills or executable extensions.

Expert prompts require: read before editing, verify paths, prefer targeted edits, diagnose failures before changing approach, use finite non-interactive commands, inspect results, never delegate recursively, and return compact JSON instead of private reasoning.

## Retry and escalation

Failure types are normalized to:

```text
tool_call_error reasoning_failure test_failure timeout provider_error
missing_context permission_error unknown
```

By default, the first correctable tool, context, or test failure receives at most one retry with a changed approach. Repeated relevant failures or provider errors switch to the next eligible, untried model. Attempt and escalation budgets are separately capped; with no candidates or exhausted budget, an unresolved state returns to the Main Agent.

There are no infinite loops, and the same failed action is never repeated blindly by policy.

## Structured results and context efficiency

Expert results contain status, role, model, summary, changed files, tests, findings, risks, recommended next action, failure type, the approximate usage Pi exposes, and bounded execution metadata. The system prefers the expert's own structured failure type and deterministically classifies test, provider, tool, and context failures; unparseable non-JSON output is marked `reasoning_failure`. Private reasoning is never requested or stored, and whole source files are never copied back into the Main Agent's context.

## Workspace safety

The system never assumes that Codex's own sandbox contains the external Pi process. The Pi Runtime uses an independent boundary:

1. Canonicalize the requested workspace path.
2. Require the path to fall under allowed roots.
3. Create a detached worktree from the repository's current `HEAD` inside a current-user-private directory under the system temp directory.
4. Give the Worker write tools inside that worktree.
5. Return the worktree path and changed-file list.
6. The Codex or Pi Main Agent inspects, integrates, and finally accepts.
7. After accepting or rejecting, call `expert_cleanup`. One call removes every worktree created for that execution ID through retries or escalations and returns all removed paths. Unclaimed worktrees are pruned automatically after `security.worktreeRetentionMs` (24 hours by default), and Git metadata is pruned alongside.

Non-Git workspaces refuse writes by default. If in-place mutation is truly required, it must be explicitly enabled:

```json
{
  "security": {
    "workspaceStrategy": "bounded-in-place",
    "allowInPlaceMutations": true,
    "allowedWorkspaceRoots": ["/absolute/path/to/project"]
  }
}
```

Read [`SECURITY.md`](SECURITY.md) before enabling.

## Telemetry and local learning

The default user data root is `%LOCALAPPDATA%\ExpertCouncil` on Windows, `$XDG_STATE_HOME/expert-council` or `~/.local/state/expert-council` on Linux, and `~/Library/Application Support/ExpertCouncil` on macOS. The shared `telemetry.jsonl` stores opaque execution outcomes so real reliability can be reused across conversations and workspaces; feedback for the same execution overwrites earlier samples and never double-counts. The shared `model-assessment.json` stores the latest explicit capability and billing scores plus runtime-learned model availability markers. `EXPERT_COUNCIL_DATA_DIR`, `EXPERT_COUNCIL_TELEMETRY`, `EXPERT_COUNCIL_MODEL_ASSESSMENT`, and `EXPERT_COUNCIL_STATE` override locations.

It never records prompts, source content, credentials, API keys, secrets, or reasoning. Aggregate metrics include per-role success rate, first-pass rate, tool error rate, retry rate, verification pass rate, and average attempts. Expert Council has no remote analytics endpoint.

Plans, execution state, and completed structured results remain workspace-scoped in `workspaces/<workspace hash>/state.json`. They survive process restarts; a task still running at restart is closed as an explicit interrupted failure. Legacy in-project `.expert-council` and `%USERPROFILE%\.expert-council` directories are not deleted automatically.

## CLI

The CLI uses exactly the same Core and Pi Runtime as MCP and the Pi Package:

```text
expert-council models
expert-council inspect
expert-council build <task>
expert-council delegate <role> <task>
expert-council feedback <execution-id> --verification passed|failed
expert-council cleanup <execution-id>
expert-council status
```

Common flags:

- `--json`: machine-readable output.
- `--cwd`: project workspace.
- `--config`: user policy file.
- `--telemetry`: custom local telemetry path.
- `--state`: custom path for persisted plans, executions, and results.
- `--timeout-ms`: expert execution timeout.

## MCP Server

The MCP surface is deliberately limited to nine semantic tools:

- `expert_inspect`
- `expert_build`
- `expert_delegate`
- `expert_wait`
- `expert_result`
- `expert_feedback`
- `expert_cleanup`
- `expert_escalate`
- `expert_status`

`expert_inspect` and `expert_build` return compact host-facing views by default. Pass `detail: "full"` only when exact model metadata, alternatives, scores, tools, or Skills are genuinely required.

`expert_delegate` starts background work and immediately returns execution IDs; the original single-assignment parameters remain compatible. The Main Agent should set an explicit `timeoutMs` per assignment based on expected difficulty instead of relying on the runtime's ten-minute fallback. When two or more independent tasks exist, dispatch the entire batch before continuing other Main Agent work:

```json
{
  "assignments": [
    { "role": "scout", "task": "locate relevant files", "taskDescription": "repo mapping", "timeoutMs": 300000 },
    { "role": "reviewer", "task": "review boundary design", "taskDescription": "boundary review", "timeoutMs": 600000 }
  ]
}
```

`assignments` must be an actual JSON array, never a string containing JSON. The native Pi adapter offers bounded compatibility parsing for models that occasionally stringify the array, but normal callers should emit real arrays.

The optional `taskDescription` is a short host-facing label for identifying the task; it is not part of the expert's actual task content. After dispatching, the Main Agent should continue all independently completable work; when nothing useful remains, call `expert_wait` once with up to eight execution IDs, usually `mode: "all"` (use `"any"` when any early result unblocks progress), and a `timeoutMs` sized to the estimated remaining difficulty. Waiting is driven by execution-promise completion events rather than polling; blocking the current MCP call is expected behavior, and no main-model tokens are consumed while waiting.

```json
{
  "executionIds": ["exec_a", "exec_b"],
  "mode": "all",
  "timeoutMs": 900000
}
```

`expert_wait` returns only completion state and task IDs; fetch the formal feedback with `expert_result` and call `expert_feedback` after the Main Agent's acceptance. `expert_wait.timeoutMs` bounds only that wait and never extends each expert's own execution deadline. Every potentially blocking Expert Council, Bash, PowerShell, or other MCP call must still carry an explicit finite timeout sized to the operation; remaining synchronous Expert Council operations are protected by an independent 30-second in-server cap. `expert_status` returns a bounded per-attempt history. The native Pi Package uses proactive completion notifications and therefore does not expose `expert_wait`.

Start the stdio server directly:

```bash
node packages/mcp-server/dist/bin.js
```

Supported environment variables:

- `EXPERT_COUNCIL_WORKSPACE`: default allowed workspace.
- `EXPERT_COUNCIL_CONFIG`: user JSON configuration.
- `EXPERT_COUNCIL_TELEMETRY`: local telemetry JSONL path.
- `EXPERT_COUNCIL_STATE`: persisted plans, executions, and results state path.
- `EXPERT_COUNCIL_MCP_TIMEOUT_MS`: bounded timeout for synchronous MCP operations, 30000 ms by default.
- `PI_CODING_AGENT_MODULE`: explicit Pi package directory when automatic resolution fails.

Environment overrides and CLI path flags are trusted operator inputs. In particular, `PI_CODING_AGENT_MODULE` loads executable code, while config, workspace, telemetry, and state paths select local files; never accept them from an untrusted repository, task text, or model output.

## Native Pi Package

For daily use, install from npm (see [Quick start](#install-the-pi-package)); this section covers source development and local candidate validation.

Build and install the local candidate from the repository root. Even on Windows, use forward slashes whenever a command may pass through Pi's Bash-compatible shell; an unquoted `.\packages\pi-package` loses its backslashes before reaching Pi.

```bash
npm run build
pi install "./packages/pi-package"
pi list
pi --verbose
```

`pi list` should show the configured source and its resolved absolute package directory. A newly started verbose Pi session should list `dist/extension.js`, the `expert-council` Skill, and the eight semantic tools without `expert_wait`. Running Pi processes do not hot-reload a rebuilt or removed package.

Or load it for one run without persisting:

```bash
pi --verbose -e "./packages/pi-package"
```

A zero-cost load check simply asks Pi to call `expert_inspect`. A real orchestration check should, in a new conversation, build one read-only council, batch two independent read-only assignments at once, confirm that `expert_delegate` immediately returns execution IDs, then accept each completion with `expert_result` and `expert_feedback`. When testing a writable expert, also confirm that one `expert_cleanup` call reports every retry worktree for the execution in `workspaces` and that `git worktree list` afterwards contains only the main checkout.

Before removing a persistent installation, exit every Pi process that loaded the package, then run from the same repository root:

```bash
pi remove "./packages/pi-package"
pi list
```

If the working directory changed, pass the resolved absolute path instead. PowerShell example:

```powershell
$ecPiPackage = (Resolve-Path "./packages/pi-package").Path
pi remove "$ecPiPackage"
pi list
```

If removal runs through Pi's Bash-compatible shell, use the forward-slash absolute path printed by `pi list`, for example `pi remove "C:/path/to/ExpertCouncil/packages/pi-package"`. Do not copy the indented relative source shown by `pi list` unless the command is resolved from the same settings-directory context.

Pi loads `dist/extension.js` and the synchronized `expert-council` Skill through the package manifest's `pi.extensions` and `pi.skills`. The extension registers the eight semantic tools; because native Pi already provides completion `steer`/`followUp`, the MCP-only `expert_wait` is omitted. It contains no second routing implementation.

Pi delegation is non-blocking; a single call can start up to eight independent background assignments before returning. When an expert finishes, the extension sends compact JSON containing the completed `executionId` and, only when supplied at dispatch, the `taskDescription`; it never carries feedback directly. Notifications use `steer` while the Main Agent is working and a `triggerTurn` `followUp` when it is idle. The Main Agent then calls `expert_result` for the structured feedback. Dispatch the entire ready batch before ending the turn, and avoid polling or silently waiting afterwards.

## Codex plugin

The Codex plugin turns Codex into the Main Agent: it bundles the shared `expert-council` Skill and a stdio MCP Server, while experts execute through Pi. It ships no hooks — the server uses MCP client roots when available, otherwise derives the task workspace from Codex's host-owned `codex/sandbox-state-meta` capability, then falls back to the `EXPERT_COUNCIL_WORKSPACE` override, and refuses to use the plugin installation directory as a workspace.

The built plugin root is:

```text
packages/codex-integration/plugin/expert-council/
  .codex-plugin/plugin.json
  .mcp.json
  skills/expert-council/SKILL.md
  dist/server.mjs
  dist/roles/*.md
```

### Installation

Release `v0.5.1` includes the prebuilt MCP server, so Codex can install the plugin directly from the repository as a pinned Git marketplace. Node.js 22.19 or newer and a working Pi installation are required at runtime; cloning and building this repository is not required.

```bash
codex plugin marketplace add Labiey/expert-council-router --ref v0.5.1 --json
codex plugin marketplace list --json
codex plugin list --marketplace expert-council-router --available --json
codex plugin add expert-council@expert-council-router --json
codex plugin list --json
```

`marketplace add` is needed only once for this release. If the marketplace name is already registered from an older or local source, remove that source first or follow the upgrade procedure below. `plugin list --json` should show `expert-council` as installed from `expert-council-router`.

Codex Desktop on Windows includes the CLI, but it may not be on `PATH`. In PowerShell, resolve the running Desktop binary and use it for the same remote installation:

```powershell
$ecCodex = (Get-Command codex.exe -ErrorAction SilentlyContinue).Source
if (-not $ecCodex) {
    $ecCodex = Get-Process codex -ErrorAction SilentlyContinue |
        Where-Object Path |
        Select-Object -First 1 -ExpandProperty Path
}
if (-not $ecCodex) {
    $ecCodex = Get-ChildItem (Join-Path $env:LOCALAPPDATA "OpenAI/Codex/bin") `
        -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ecCodex) { throw "Codex Desktop CLI was not found." }

& $ecCodex plugin marketplace add Labiey/expert-council-router --ref v0.5.1 --json
& $ecCodex plugin marketplace list --json
& $ecCodex plugin list --marketplace expert-council-router --available --json
& $ecCodex plugin add "expert-council@expert-council-router" --json
& $ecCodex plugin list --json
```

Fully quit Codex Desktop, wait for its backend process to exit, reopen it, and start a new task. Merely opening another task is not a reliable MCP reload boundary in every Desktop build.

For local plugin development, clone the repository, run `npm ci && npm run build`, and pass its absolute root to `codex plugin marketplace add` instead of the GitHub repository name. The pinned remote release is recommended for normal use.

A correct load exposes the `expert-council` Skill and all nine `expert_*` MCP tools. If the Skill is present but the tools are absent, treat the installation as failed: restart or reinstall the plugin instead of launching `dist/server.mjs` manually or sending hand-written JSON-RPC.

To verify the installed workflow, use a new Codex task and ask:

```text
Use Expert Council to inspect the currently available Pi models, providers, billing classification, and model-assessment status. Return only a compact summary; do not build a council or delegate experts.
```

The task should invoke `expert_inspect`. It should not ask for hook trust, manually launch the MCP server, or treat the plugin cache as the project workspace.

### Upgrade

A marketplace pinned with `--ref` intentionally stays on that release. To upgrade, remove the installed plugin and old marketplace registration, then add the new tag and reinstall:

```bash
codex plugin remove expert-council@expert-council-router --json
codex plugin marketplace remove expert-council-router --json
codex plugin marketplace add Labiey/expert-council-router --ref vX.Y.Z --json
codex plugin add expert-council@expert-council-router --json
```

Replace `vX.Y.Z` with the intended release. Users who deliberately track the default branch can omit `--ref` and later run `codex plugin marketplace upgrade expert-council-router --json`, but pinned tags are safer for normal use. After reinstalling, fully restart Codex Desktop and test in a new task. Avoid installing multiple copies that all declare the `expert_council` MCP server.

### Behavior highlights

- The bundled `.mcp.json` raises the host tool-call ceiling to 3660 seconds so a single bounded `expert_wait` can block until completion; the Skill still requires explicit per-operation deadlines rather than treating that ceiling as a default budget.
- On the first council of a conversation the Main Agent establishes exactly one cost policy with you (economy, balanced, or speed); until then `expert_build` and `expert_delegate` responses carry reminders to ask.
- Writable experts mutate inside a detached Git worktree under the trusted workspace; changes come back for Main Agent review and are never auto-merged.

### Removal

Remove the plugin and its marketplace registration:

```bash
codex plugin remove expert-council@expert-council-router --json
codex plugin marketplace remove expert-council-router --json
codex plugin list --json
codex plugin marketplace list --json
```

On Windows, replace `codex` with `& $ecCodex` when using the PowerShell variable above. Fully quit Codex Desktop before starting new tasks.

## Testing

```bash
npm test
npm run typecheck
npm run build
npm run pack:check
npm run validate
```

`npm run validate` builds first so a fresh clone has the workspace package entries generated before testing. Tests cover model normalization, published prices versus real policy billing, worker reliability, oracle scoring, reviewer diversity, hard constraints, unknown and missing models, team sizing, retries with per-attempt diagnostics, structured failure classification, escalation, retry limits, role permissions, compact host output, configuration validation, telemetry privacy/feedback/usage aggregation, Core host independence, mocked Pi discovery and execution, CLI JSON, MCP schemas, real Pi 0.84.4 extension loading/wrapping and async batch notifications, Pi extension registration, and real Git worktree isolation.

Ordinary tests only use the mock runtime and never call paid models. A real read-only Pi execution requires both an explicit model and an explicit cost acknowledgement:

```powershell
$env:EXPERT_COUNCIL_LIVE_MODEL = "provider/model"
$env:EXPERT_COUNCIL_LIVE_CONFIRM = "YES"
npm run smoke:live:pi
```

Ordinary validation flows never execute that script.

## Publishing

Run `npm run validate` first, inspect every `npm pack --dry-run` file list, then publish in dependency order:

```text
@expert-council/core
@expert-council/pi-runtime
@expert-council/cli
@expert-council/mcp-server
@expert-council/pi-package
```

## Known limitations

- Pi's API moves quickly. The current release was verified against the local 0.84.4 SDK; the runtime checks required SDK, model-runtime, resource-loader, and session methods and lists any missing contract explicitly on incompatibility.
- Pi has no unified real billing-type API. Runtime subscription signals and named Token Plans take priority; otherwise non-zero catalog prices are treated as metered, and providers without reliable evidence stay `unknown` until an audit or explicit user configuration confirms them.
- Expert Council does not infer subjective coding quality from model names, nor does it download benchmark presets automatically.
- Detached worktrees start from the committed `HEAD` and do not copy uncommitted changes from the main workspace. This is deliberate isolation; the runtime detects a dirty source workspace and surfaces the deviation through runtime limitations and mutation-council warnings before delegation.
- Worktree changes are returned for Main Agent review and are never auto-merged or applied; call `expert_cleanup` after acceptance or rejection, or they will be cleaned up automatically after the retention window.
- Writes to non-Git workspaces require explicit in-place mutation authorization.
- In-flight model calls do not resume after a server restart; persisted state closes them as explicit interrupted failures while preserving plans and completed results.
- Codex's own sandbox does not automatically contain the external Pi runtime, so Expert Council uses separate allowed roots and worktree boundaries.
- Expert Council contains no arbitrary third-party package installation, recursive expert trees, graphical interface, remote control plane, or remote telemetry.

## License

MIT; see [`LICENSE`](LICENSE).
