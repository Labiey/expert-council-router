# Expert Council

[English](README.md) | [简体中文](README.zh-CN.md)

Expert Council is a local, cost-aware multi-model orchestration layer for Pi and MCP-capable hosts such as Codex. It discovers models that Pi can actually call, combines runtime metadata with user billing and capability policy, assembles a small semantic expert team, executes bounded experts through Pi, and returns compact structured results.

The strongest theoretical model is not automatically the best worker. A slightly weaker model with reliable tools, predictable shell behavior, and low marginal cost can have higher expected task value. Expert Council makes that tradeoff deterministic and configurable while leaving ambiguous judgment and final acceptance with the Main Agent.

## Status

V1 includes:

- Host-independent Core with configuration validation, model normalization, billing, profile layering, role scoring, task classification, council sizing, retry/escalation, and telemetry aggregation.
- Pi runtime using Pi's current `ModelRuntime` and `createAgentSession` APIs.
- Hard per-session tool allowlists and installed-Skill filtering.
- Detached Git worktree isolation for mutation experts.
- JSON CLI.
- Nine-tool asynchronous semantic MCP server with event-driven completion waiting and explicit worktree cleanup.
- Native Pi Package.
- Valid Codex plugin with a shared host Skill and bundled stdio MCP server.
- Deterministic tests that never spend model credits.

The implementation was verified against local Pi `@earendil-works/pi-coding-agent` 0.84.4. The adapter capability-detects the upstream `@mariozechner/pi-coding-agent` package as well. See [Known limitations](#known-limitations) for explicit degradation behavior.

## Architecture

```text
Codex or Pi Main Agent
          |
          | semantic tools / shared Skill
          v
  Expert Council Core
  - inventory normalization
  - billing and profiles
  - deterministic routing
  - roles and council sizing
  - retry/escalation
  - telemetry aggregation
          |
          v
      Pi Runtime
  - callable model discovery
  - hard tool allowlists
  - installed Skill filtering
  - bounded expert sessions
  - workspace isolation
       /      |      \
     CLI   Pi Package  MCP server
                         |
                    Codex plugin
```

Dependency direction is enforced with TypeScript project references:

```text
core <- pi-runtime <- cli
                   <- mcp-server <- codex-integration
                   <- pi-package
```

Core imports no Pi, Codex, MCP transport, filesystem, shell, or process API. The CLI, MCP server, and host packages share the same service and routing code.

## Quick start

Requirements:

- Node.js 22.19 or newer.
- npm 11 or compatible.
- A working Pi installation with at least one authenticated model.
- Git with at least one commit when mutation experts should use worktree isolation.

```bash
npm install
npm run build
npm test
```

Inspect currently callable models without invoking one:

```bash
node packages/cli/dist/bin.js models --json
node packages/cli/dist/bin.js inspect --json
```

Build a council without executing experts:

```bash
node packages/cli/dist/bin.js build "fix the device hot-swap race condition" --max-experts 4 --json
```

Delegate only when you intentionally want a Pi model call:

```bash
node packages/cli/dist/bin.js delegate architecture-oracle "analyze the concurrency path" --workspace /path/to/repo --json
```

Zero configuration uses conservative capability defaults, classifies unknown billing as `unknown`, and refuses non-isolated mutation. It never guesses that an API is free or that a named model is objectively strong.

## Model discovery

`PiExpertRuntime` calls Pi's `ModelRuntime.getAvailable()`, not a hardcoded catalog. A model present in a registry or user profile is not routed unless Pi reports it currently available. The adapter normalizes:

- provider and model ID;
- display name;
- reasoning support and Pi's supported reasoning-level map;
- context and output windows;
- input modalities;
- published API cost fields;
- safe compatibility metadata.

The runtime first resolves a locally installed compatible Pi SDK, then an explicit `PI_CODING_AGENT_MODULE` directory, then a compatible global npm Pi installation. Failure returns an actionable diagnostic instead of silently falling back to a fake model list.

## Configuration

Set `EXPERT_COUNCIL_CONFIG` or pass `--config PATH` to CLI commands. Start with [balanced.example.json](config/examples/balanced.example.json).

Profile precedence is:

```text
conservative built-in defaults
  < optional/user configuration
  < per-task runtime overrides
```

Objective runtime metadata is merged separately. Local outcome data adjusts a routing score only after three samples and is capped by `routing.localLearningMaxAdjustment`. Explicit user configuration remains authoritative.

### Billing policy

Billing types are `subscription`, `metered`, `quota`, `free`, and `unknown`. Marginal cost and usage preference are separate because published token prices do not describe subscriptions, fixed quotas, local inference, or promotional access. The Pi runtime adapter classifies an explicit runtime subscription or named Token Plan catalog as `subscription`; otherwise, a provider with non-zero Pi catalog prices is `metered`, and a provider without reliable evidence remains `unknown`. Every inference includes its source in `expert_inspect`, and explicit user configuration remains authoritative. Per-model catalog prices still distinguish models inside a metered provider through `routing.apiPriceWeight` (default `0.35`); an all-zero price table is treated as unspecified, not proof that access is free.

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

Examples are in `config/examples/`:

- `balanced.example.json`: conservative zero-config-compatible policy.
- `subscription-heavy.example.json`: consume subscriptions before scarce quota.
- `metered-quality.example.json`: distinguish economy and premium metered APIs.
- `qwen-glm.example.json`: explicitly hypothetical user scores, not benchmark claims.

### Capability profiles

Models may be scored from 0 to 10 on:

```text
reasoning planning architecture coding debugging review longContext
toolReliability bashReliability autonomousExecution speed
```

Use the exact normalized `provider/model` key returned by `models --json`. Missing or newly discovered models receive conservative defaults. A profile for a missing model produces a warning and never crashes routing.

### Main Agent audits and first-council preference

Users do not need to maintain a priority for every model. Once the Main Agent decides that a task warrants a council, the first council in a new conversation asks once—unless the user already stated a preference—whether to optimize for:

```text
economy  lowest effective marginal cost
balanced cost, completion time, and success probability
speed    fastest completion
```

The Pi Package records the choice as hidden extension state in the current Pi Session. Later councils in that conversation reuse it unless the user explicitly changes it. `economy` increases cost weight, `speed` increases the audited speed dimension, and `balanced` keeps normal role weights. The legacy `quality` API value remains compatible but is not offered in the default question.

The Main Agent assesses models instead of asking the user to rank them. `expert_inspect` reports a mandatory assessment gate. When no audit exists, it is older than 30 days, callable models change, or the user explicitly asks to re-audit capabilities, the Main Agent must use an already available network tool to research every callable model listed by the gate before `expert_build` can assemble a council. It submits one complete `modelAssessment` with an ISO timestamp read from the actual host clock, 1–12 consolidated source URLs, normalized 0–10 capability dimensions, and verified provider access/billing classifications. A future-dated timestamp is reported separately and can be corrected without repeating research. When inspection reports the saved assessment as current, the host omits `modelAssessment` from `expert_build`; an incomplete, stale, or future-dated replacement cannot displace a current saved snapshot. The assessment is stored once in the current user's data directory and reused across conversations and workspaces while the callable inventory remains compatible. Ordinary plan/execution state saves preserve that global assessment instead of rewriting it from a stale service instance; only an explicit successful assessment submission replaces it. Explicit user billing configuration remains authoritative; unverifiable access remains `unknown`.

Triangulate rather than trusting one leaderboard: [Artificial Analysis Data API](https://artificialanalysis.ai/data-api/docs) provides coding, agentic, pricing, throughput, and latency data; [LiveBench](https://livebench.ai/) covers coding and agentic coding; [Arena](https://arena.ai/leaderboard/text) measures human preference; provider documentation confirms versions, context, tools, and access methods. [OpenRouter Rankings](https://openrouter.ai/rankings?category=programming) primarily measure real usage and should be treated only as adoption evidence, not proof of quality. If the host lacks a network tool when the gate requires an audit, it must report that limitation instead of silently routing with unaudited defaults. Expert Council never installs a browser, Skill, plugin, or executable package automatically.

### Role weights

Each semantic role has normalized defaults. A Worker emphasizes tool reliability, coding, autonomy, and shell reliability. An Architecture Oracle emphasizes architecture, planning, long context, and review. Override only the fields that reflect your environment:

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

Weights are renormalized. `costPolicy: economy` increases the configured cost contribution; `speed` increases speed and reduces cost weight; legacy `quality` reduces cost weight. None removes hard security or compatibility constraints.

## Roles and council sizing

Roles are semantic and independent of model names:

| Role | Default mode | Purpose |
|---|---|---|
| Planner | read-only | decomposition, dependencies, risks |
| Scout | read-only | repository exploration and context compression |
| Architecture Oracle | read-only | difficult cross-file reasoning and second opinion |
| Implementation Worker | mutation | bounded code changes and focused tests |
| Debugger | mutation | reproduce, isolate, fix, verify |
| Reviewer | read-only | prioritized regression and design review |
| Verifier | read-only | inspect reported tests, diffs, and acceptance checks |

Tiny tasks use one Worker. Normal tasks use a Worker and Verifier. Complex features use Planner, Worker, Reviewer, and Verifier. Complex debugging uses Scout, Debugger, Oracle, and Verifier. `maxExperts` caps the result, and the Main Agent is never duplicated as a `lead` expert.

Task classification and all arithmetic are deterministic. The host can inspect the selected model, alternatives, score, and concise reasons before delegation.

Council construction also applies configurable diversity penalties. In particular, a Reviewer economically prefers a different provider and inferred model family from earlier council members, while role fitness and hard constraints remain decisive.

## Routing

The routing pipeline is:

```text
discover callable candidates
  -> apply hard constraints
  -> merge capability/profile layers
  -> score role fit and effective cost
  -> apply conservative local outcome adjustment
  -> rank with stable tie-breaking
  -> return selection, alternatives, and reasons
```

Hard constraints reject unavailable or disabled models, incompatible roles, insufficient tool reliability, insufficient context, mutation without runtime support, and `escalation-only` billing for routine routing.

Reasoning effort is optional and model-specific. A configured role preference is used only when Pi exposes it for the selected model; otherwise Pi keeps or clamps its supported default.

## Skills and least privilege

The canonical platform-neutral host guidance is [SKILL.md](shared/skills/expert-council/SKILL.md). Small host overlays under `shared/skills/expert-council/hosts/` are composed with that base during the build, producing separate Pi and Codex `SKILL.md` artifacts without duplicating the shared workflow. The Pi artifact teaches completion `steer`/`followUp` behavior and never exposes `expert_wait`; the Codex artifact teaches the bounded `expert_wait` workflow. Shared role prompts live under `packages/core/src/roles/prompts/` and are copied as package assets; they are not rewritten per host.

Read-only roles never receive `edit`, `write`, `bash`, or `powershell`, even if a caller tries to include them. Pi sessions use the actual `tools` allowlist, so this is stronger than prompt-only guidance. Shell-backed testing belongs to an isolated mutation role until a dedicated non-mutating command runner is available.

Only already-installed, enabled Pi Skills requested by the role are activated. User-scope Skills are trusted; project/temporary Skills are excluded unless their exact name appears in `security.trustedSkills`. Every expert resource loader disables extensions, prompt templates, themes, and project context files, and the runtime refuses Pi SDK versions that cannot enforce these controls. Expert Council never downloads or installs a Skill or executable extension.

Every expert is instructed to inspect before editing, verify paths, prefer targeted changes, diagnose tool failures before retrying, use finite commands, inspect results, avoid recursive delegation, and return compact JSON rather than private reasoning.

## Retry and escalation

Failures are normalized as:

```text
tool_call_error reasoning_failure test_failure timeout provider_error
missing_context permission_error unknown
```

A first correctable tool, context, or test failure receives at most one changed retry by default. Repeated relevant failures or provider errors move to the next eligible untried model. Attempts and escalations have independent limits. When no valid candidate or budget remains, the unresolved result returns to the Main Agent.

There is no unbounded loop and no repeated retry of the same approach by policy.

## Structured results and context efficiency

Expert results contain status, role, model, summary, changed files, tests, findings, risks, next action, failure type, approximate Pi usage when exposed, and bounded execution metadata. Explicit structured failure types are preferred; failed tests and provider/tool/context messages are classified deterministically, while malformed non-JSON expert output becomes `reasoning_failure`. Raw source files and private chain-of-thought are neither requested nor stored. Text fields and arrays are bounded before being returned to the host.

## Workspace security

Mutation is not assumed safe merely because Codex itself is sandboxed. The external Pi process has its own boundary:

1. Canonicalize the requested workspace.
2. Require it to be under an allowed root.
3. Create a detached worktree from the repository's current `HEAD` under a current-user-specific private directory in the OS temporary directory.
4. Run the Worker there with mutation tools.
5. Return the worktree path and changed-file list.
6. Leave integration and final acceptance to Codex or the Pi Main Agent.
7. Call `expert_cleanup` after integrating or rejecting the result. One call removes every worktree created by retries or escalations for that execution ID and reports all removed paths. Unclaimed worktrees are removed after `security.worktreeRetentionMs` (24 hours by default), and Git metadata is pruned.

For a non-Git workspace, mutation fails safely by default. To opt into bounded in-place changes:

```json
{
  "security": {
    "workspaceStrategy": "bounded-in-place",
    "allowInPlaceMutations": true,
    "allowedWorkspaceRoots": ["/absolute/path/to/project"]
  }
}
```

See [SECURITY.md](SECURITY.md) before enabling it.

## Telemetry and local learning

The default user data root is `%LOCALAPPDATA%\ExpertCouncil` on Windows, `$XDG_STATE_HOME/expert-council` or `~/.local/state/expert-council` on Linux, and `~/Library/Application Support/ExpertCouncil` on macOS. Shared `telemetry.jsonl` records opaque outcomes and makes observed reliability reusable across conversations and workspaces. Call `expert_feedback` after Main Agent verification; updates for the same execution replace earlier samples rather than double-counting them. Shared `model-assessment.json` stores the latest explicit capability/billing scores. `EXPERT_COUNCIL_DATA_DIR`, `EXPERT_COUNCIL_TELEMETRY`, `EXPERT_COUNCIL_MODEL_ASSESSMENT`, and `EXPERT_COUNCIL_STATE` can override these locations.

It does not record prompts, source content, credentials, secrets, API keys, or chain-of-thought. Aggregates include role success rate, first-pass success, tool-error rate, retry rate, verification pass rate, and average attempts. There is no remote analytics endpoint.

Plans, execution states, and completed structured results remain workspace-specific under `workspaces/<workspace-hash>/state.json`. After restart, plans and completed results remain queryable; an execution that was still running is closed as a failed interrupted result rather than being falsely reported as active. Older project-local `.expert-council` and `%USERPROFILE%\.expert-council` directories are not deleted automatically.

## CLI

The CLI uses exactly the same Core and Pi runtime:

```text
expert-council models
expert-council inspect
expert-council build <task>
expert-council delegate <role> <task>
expert-council feedback <execution-id> --verification passed|failed
expert-council cleanup <execution-id>
expert-council status
```

Use `--json` for scripting, `--cwd` for workspace, `--config` for policy, `--telemetry` for a non-default telemetry store, `--state` for durable council state, and `--timeout-ms` for delegation.

## MCP server

The semantic surface is deliberately small:

- `expert_inspect`
- `expert_build`
- `expert_delegate`
- `expert_wait`
- `expert_result`
- `expert_feedback`
- `expert_cleanup`
- `expert_escalate`
- `expert_status`

`expert_inspect` and `expert_build` return compact host-facing views by default. Pass `detail: "full"` only when exact model metadata, alternatives, scores, tools, or Skills are required.

`expert_delegate` starts background work and immediately returns execution IDs. The original single-assignment shape remains supported. Set an explicit `timeoutMs` for each assignment based on expected difficulty rather than relying on the ten-minute runtime fallback. For two or more independent tasks, dispatch the whole batch before doing other Main Agent work:

```json
{
  "assignments": [
    { "role": "scout", "task": "Map the relevant files", "taskDescription": "repository map", "timeoutMs": 300000 },
    { "role": "reviewer", "task": "Review the proposed boundary", "taskDescription": "boundary review", "timeoutMs": 600000 }
  ]
}
```

`assignments` must be a real JSON array, not a string containing JSON text. The native Pi adapter includes a bounded compatibility repair for models that occasionally stringify the array, but normal calls should emit the array directly.

Its optional `taskDescription` is a concise host-facing label, not part of the expert assignment. After dispatch, the Main Agent should continue any independent work. When no useful work remains, call `expert_wait` once with up to eight execution IDs, `mode: "all"` (or `"any"` when one early result is actionable), and a difficulty-based `timeoutMs`. The wait is event-driven rather than polling and intentionally blocks the current MCP tool call without consuming model tokens. It returns only completion state and IDs; use `expert_result` for feedback, then call `expert_feedback` with the Main Agent's verification outcome.

```json
{
  "executionIds": ["exec_a", "exec_b"],
  "mode": "all",
  "timeoutMs": 900000
}
```

`expert_wait.timeoutMs` limits only that wait and does not extend the per-assignment execution deadline. The Codex plugin sets its MCP transport safety ceiling to 3660 seconds so a justified one-hour wait can finish with margin; all blocking Expert Council and host shell/MCP calls should still carry a smaller explicit finite timeout chosen for the operation. Other synchronous Expert Council operations retain their separate 30-second server-side bound. `expert_status` includes a bounded per-attempt history with model, status, failure type, and short failure summary. The native Pi Package uses completion push instead of exposing `expert_wait`.

Run the stdio server directly:

```bash
node packages/mcp-server/dist/bin.js
```

Environment:

- `EXPERT_COUNCIL_WORKSPACE`: default allowed workspace.
- `EXPERT_COUNCIL_CONFIG`: user JSON configuration.
- `EXPERT_COUNCIL_TELEMETRY`: local telemetry JSONL path.
- `EXPERT_COUNCIL_STATE`: durable plan/execution/result state path.
- `EXPERT_COUNCIL_MCP_TIMEOUT_MS`: finite timeout for synchronous MCP operations; defaults to 30000.
- `PI_CODING_AGENT_MODULE`: explicit Pi package directory when automatic resolution is unavailable.

Environment overrides and CLI path flags are trusted operator inputs. In particular, `PI_CODING_AGENT_MODULE` loads executable code, while config, workspace, telemetry, and state paths select local files. Do not accept these values from an untrusted repository, task text, or model output.

The Codex plugin does not use its installation directory as the task workspace. Its `.mcp.json` working directory exists only to launch the bundled server. The server prefers the current local project's MCP `file:` roots. Current Codex Desktop builds that do not advertise MCP roots use the bundled synchronous `PreToolUse` hook instead: immediately before an `expert_*` call, the hook records the host-supplied session ID and `cwd` in the plugin's private `PLUGIN_DATA` directory, and the server accepts only the record matching its own Codex session ID. Review and trust this small hook after installation. Explicit `security.allowedWorkspaceRoots` remains authoritative and may narrow that boundary. If neither trusted channel is available, the plugin fails closed rather than granting access to arbitrary local paths. `EXPERT_COUNCIL_WORKSPACE` remains a trusted operator fallback.

A generic Codex MCP configuration can launch that absolute script path. The native Codex plugin below already bundles and configures the server.

## Native Pi Package

Build and install the local candidate from the repository root. Use forward slashes even on Windows when a command may pass through Pi's Bash-compatible shell; an unquoted Windows path such as `.\packages\pi-package` can lose its backslashes before Pi receives it.

```bash
npm run build
pi install "./packages/pi-package"
pi list
pi --verbose
```

`pi list` should show the configured source and its resolved absolute package directory. A newly started verbose Pi session should list `dist/extension.js`, the `expert-council` Skill, and eight semantic tools without `expert_wait`. Existing Pi processes do not hot-reload a rebuilt or removed package.

Or for one run without persisting it:

```bash
pi --verbose -e "./packages/pi-package"
```

For a no-cost loading check, ask Pi to call `expert_inspect` only. For a live orchestration check, start a new conversation, build one read-only council, batch two independent read-only assignments, confirm that `expert_delegate` immediately returns execution IDs, then verify each completion with `expert_result` and `expert_feedback`. A mutation test should additionally confirm that one `expert_cleanup` call reports every retry worktree in `workspaces` and that `git worktree list` contains only the main checkout afterwards.

Exit every Pi process that loaded the package before removing the persisted entry:

```bash
pi remove "./packages/pi-package"
pi list
```

Run removal from the same repository root used above. If the working directory has changed, pass the resolved absolute path instead. In PowerShell:

```powershell
$ecPiPackage = (Resolve-Path "./packages/pi-package").Path
pi remove "$ecPiPackage"
pi list
```

If removal is launched through Pi's Bash-compatible shell, use the forward-slash absolute path printed by `pi list`, for example `pi remove "C:/path/to/ExpertCouncil/packages/pi-package"`. Do not copy the indented relative source shown by `pi list` unless the command is being resolved from the same settings-directory context.

Pi loads `dist/extension.js` and the synchronized `expert-council` Skill through the package's current `pi.extensions` and `pi.skills` manifest. The extension registers eight semantic tools; it omits MCP's `expert_wait` because native Pi provides completion `steer`/`followUp` delivery. Pi package code depends on the shared Core and runtime; it does not duplicate routing.

Pi delegation is non-blocking. A batch of up to eight independent assignments is started before the tool returns. When an expert finishes, the extension sends compact JSON containing its completed `executionId` and, only when supplied, `taskDescription`; it never includes feedback. If the Main Agent is working, the notification is delivered as `steer`; if it is idle, a `followUp` with `triggerTurn` wakes it immediately. The Main Agent then calls `expert_result` to fetch the structured feedback. The Main Agent should dispatch the entire ready batch before ending its turn, then avoid polling or silently waiting.

For npm distribution, publish Core and Pi Runtime before Pi Package so its versioned workspace dependencies resolve.

## Codex plugin

The built plugin root is:

```text
packages/codex-integration/plugin/expert-council/
  .codex-plugin/plugin.json
  .mcp.json
  hooks/hooks.json
  hooks/record-workspace.mjs
  skills/expert-council/SKILL.md
  dist/server.mjs
  dist/roles/*.md
```

It follows the current Codex plugin layout: the manifest points at `skills/`, a bundled `.mcp.json`, and a workspace-recording hook; the stdio server is bundled into the plugin and locates the user's installed Pi SDK without embedding credentials. The MCP launch `cwd` is the installed plugin root only for resolving `dist/server.mjs`; authorized repository paths come separately from MCP roots or the matching session record written by the trusted hook. The bundled MCP config raises the host tool-call ceiling to 3660 seconds for bounded `expert_wait` calls; the Skill requires the Main Agent to choose explicit operation-specific deadlines rather than treating that ceiling as a default budget.

To test locally, expose the plugin through a personal or repo marketplace as documented by the current [OpenAI plugin packaging guide](https://developers.openai.com/plugins/build/plugins). No marketplace file is written automatically by this repository because that changes user or team Codex configuration. Validate the plugin itself with:

```bash
python C:/path/to/plugin-creator/scripts/validate_plugin.py packages/codex-integration/plugin/expert-council
```

For local development, reuse one stable personal or repository marketplace and update the plugin cachebuster before reinstalling. Remove obsolete test installations before changing marketplace identity; installing multiple copies that all declare the `expert_council` MCP server can make host diagnostics ambiguous. After every install or reinstall, fully quit Codex Desktop, wait for its backend process to exit, reopen the app, and start a new task. Merely opening a new task is not a reliable MCP reload boundary in every Desktop build.

On first use after installation, review and trust the bundled hook when Codex prompts. It runs synchronously only before `mcp__expert_council__expert_*` calls, receives the host-provided session metadata, writes only the session ID, canonical `cwd`, and timestamp to `PLUGIN_DATA`, emits no model context, and has a five-second ceiling. Codex versions that already provide MCP roots do not depend on the record, but keeping the hook trusted preserves compatibility with Desktop 0.152.x.

A correct load exposes both the `expert-council` Skill and all nine native `expert_*` MCP tools. If the Skill is present but those tools are absent, treat the installation as failed. The Main Agent must not launch `dist/server.mjs` from Bash or PowerShell, send hand-written JSON-RPC, or use the CLI to impersonate a missing MCP tool; restart or reinstall the plugin instead.

The plugin's Main Agent guidance explicitly keeps final architecture and acceptance in Codex and avoids a redundant lead expert.

## Testing

```bash
npm test
npm run typecheck
npm run build
npm run pack:check
npm run validate
```

`npm run validate` builds first so a fresh clone has workspace package entry points before tests run. The deterministic suite covers model normalization, published-price and real-policy billing, Worker reliability, Oracle scoring, reviewer diversity, hard constraints, unknown and missing models, council sizing, retry and per-attempt diagnostics, structured failure classification, escalation, retry limits, role permissions, compact host presentation, config validation, telemetry privacy/feedback/usage aggregation, Core host independence, mock Pi discovery/execution, CLI JSON, MCP schemas, real Pi 0.84.4 extension loading/wrapping with asynchronous batch notification delivery, and Pi extension registration.

Normal tests use mock runtimes and never call a paid model. A live read-only Pi execution is available only with both an explicit model and an exact cost acknowledgement:

```powershell
$env:EXPERT_COUNCIL_LIVE_MODEL = "provider/model"
$env:EXPERT_COUNCIL_LIVE_CONFIRM = "YES"
npm run smoke:live:pi
```

The normal validation pipeline never invokes this script.

## Publishing

Run `npm run validate`, inspect every `npm pack --dry-run` file list, then publish in dependency order:

```text
@expert-council/core
@expert-council/pi-runtime
@expert-council/cli
@expert-council/mcp-server
@expert-council/pi-package
```

The Codex integration is a plugin artifact rather than a clone of the Pi Package. Before a public plugin submission, add real repository, support, privacy, and publisher metadata required by the target catalog; do not invent those values in source.

## Known limitations

- Pi APIs evolve quickly. V1 is verified against the installed 0.84.4 SDK. Required SDK, model-runtime, resource-loader, and session methods are capability-validated; incompatible versions fail with a specific missing-contract diagnostic.
- Pi does not expose a universal real-world billing type. Runtime subscription signals and named Token Plan catalogs take precedence; otherwise non-zero catalog prices imply metered routing, while providers without reliable evidence remain `unknown` until assessment or explicit configuration confirms them.
- V1 does not infer subjective coding quality from model names or fetch benchmark presets.
- Detached worktrees start from committed `HEAD`; uncommitted Main Agent changes are not copied. This is intentional isolation. The runtime detects a dirty source workspace and reports the mismatch in runtime limitations and mutation council warnings before delegation.
- Worktree changes are returned for review, not automatically merged or applied. They require `expert_cleanup` after acceptance/rejection and otherwise expire after the configured retention window.
- Mutation in non-Git workspaces requires explicit in-place opt-in.
- Active model calls are not resumed after server restart; durable state converts them to explicit interrupted failures while preserving plans and completed results.
- Skill discovery, project trust resolution, extension suppression, and hard tool restriction are required from the verified Pi SDK. A Pi build missing any enforcement API is rejected instead of silently weakening isolation.
- Codex's own sandbox does not contain an external Pi runtime. Expert Council therefore enforces its separate allowed-root and worktree boundary.
- No arbitrary package installation, recursive expert trees, graphical UI, remote control plane, or remote analytics is included in V1.

## License

MIT. See [LICENSE](LICENSE).
