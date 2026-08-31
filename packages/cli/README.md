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
- Six-tool asynchronous semantic MCP server.
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

Billing types are `subscription`, `metered`, `quota`, `free`, and `unknown`. Marginal cost and usage preference are separate because published token prices do not describe subscriptions, fixed quotas, local inference, or promotional access.

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

Weights are renormalized. `costPolicy: economy` increases the configured cost contribution; `quality` reduces it. It never removes hard security or compatibility constraints.

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
| Verifier | read-only + shell | tests, diffs, and acceptance checks |

Tiny tasks use one Worker. Normal tasks use a Worker and Verifier. Complex features use Planner, Worker, Reviewer, and Verifier. Complex debugging uses Scout, Debugger, Oracle, and Verifier. `maxExperts` caps the result, and the Main Agent is never duplicated as a `lead` expert.

Task classification and all arithmetic are deterministic. The host can inspect the selected model, alternatives, score, and concise reasons before delegation.

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

The canonical host guidance is [SKILL.md](shared/skills/expert-council/SKILL.md). The build synchronizes it into Pi and Codex distributions. Shared role prompts live under `packages/core/src/roles/prompts/` and are copied as package assets; they are not rewritten per host.

Read-only roles never receive `edit` or `write`, even if a caller tries to include them. Pi sessions use the actual `tools` allowlist, so this is stronger than prompt-only guidance. On Windows the runtime exposes `powershell`; on Unix it exposes `bash`.

Only already-installed, enabled Pi Skills requested by the role are activated. A Skill marked untrusted is excluded unless explicitly named in `security.trustedSkills`. Expert Council never downloads or installs a Skill or executable extension.

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

Expert results contain status, role, model, summary, changed files, tests, findings, risks, next action, and bounded execution metadata. Raw source files and private chain-of-thought are neither requested nor stored. Text fields and arrays are bounded before being returned to the host.

## Workspace security

Mutation is not assumed safe merely because Codex itself is sandboxed. The external Pi process has its own boundary:

1. Canonicalize the requested workspace.
2. Require it to be under an allowed root.
3. Create a detached worktree from the repository's current `HEAD` under the OS temporary directory.
4. Run the Worker there with mutation tools.
5. Return the worktree path and changed-file list.
6. Leave integration and final acceptance to Codex or the Pi Main Agent.

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

The default local store is `.expert-council/telemetry.jsonl`. It records model, provider, role, task category, success, first-pass outcome, tool-error count, retries, timeout, verification outcome when supplied, escalation count, attempts, host type, and optional approximate token usage.

It does not record prompts, source content, credentials, secrets, API keys, or chain-of-thought. Aggregates include role success rate, first-pass success, tool-error rate, retry rate, verification pass rate, and average attempts. There is no remote analytics endpoint.

## CLI

The CLI uses exactly the same Core and Pi runtime:

```text
expert-council models
expert-council inspect
expert-council build <task>
expert-council delegate <role> <task>
expert-council status
```

Use `--json` for scripting, `--cwd` for workspace, `--config` for policy, `--telemetry` for a non-default local store, and `--timeout-ms` for delegation.

## MCP server

The semantic surface is deliberately small:

- `expert_inspect`
- `expert_build`
- `expert_delegate`
- `expert_result`
- `expert_escalate`
- `expert_status`

`expert_delegate` starts background work and immediately returns an `executionId`. Its optional `taskDescription` is a concise host-facing label, not part of the expert assignment. Use `expert_result` to retrieve feedback once execution completes. Generic MCP hosts query `expert_result` or `expert_status`; the native Pi Package additionally pushes a completion message into the Main Agent session.

Run the stdio server directly:

```bash
node packages/mcp-server/dist/bin.js
```

Environment:

- `EXPERT_COUNCIL_WORKSPACE`: default allowed workspace.
- `EXPERT_COUNCIL_CONFIG`: user JSON configuration.
- `PI_CODING_AGENT_MODULE`: explicit Pi package directory when automatic resolution is unavailable.

A generic Codex MCP configuration can launch that absolute script path. The native Codex plugin below already bundles and configures the server.

## Native Pi Package

After building the monorepo, try the package locally:

```bash
pi install ./packages/pi-package
```

Or for one run without persisting it:

```bash
pi -e ./packages/pi-package
```

Pi loads `dist/extension.js` and the synchronized `expert-council` Skill through the package's current `pi.extensions` and `pi.skills` manifest. The extension registers the same six semantic tools as MCP. Pi package code depends on the shared Core and runtime; it does not duplicate routing.

Pi delegation is non-blocking. When an expert finishes, the extension sends compact JSON containing its completed `executionId` and, only when supplied, `taskDescription`; it never includes feedback. If the Main Agent is working, the notification is delivered as `steer`; if it is idle, a `followUp` with `triggerTurn` wakes it immediately. The Main Agent then calls `expert_result` to fetch the structured feedback. Because completion reawakens native Pi automatically, the Main Agent should end its turn after dispatching or completing other useful work rather than poll or silently wait and spend tokens.

For npm distribution, publish Core and Pi Runtime before Pi Package so its versioned workspace dependencies resolve.

## Codex plugin

The built plugin root is:

```text
packages/codex-integration/plugin/expert-council/
  .codex-plugin/plugin.json
  .mcp.json
  skills/expert-council/SKILL.md
  dist/server.mjs
  dist/roles/*.md
```

It follows the current Codex plugin layout: the manifest points at `skills/` and a bundled `.mcp.json`; the stdio server is bundled into the plugin and locates the user's installed Pi SDK without embedding credentials.

To test locally, expose the plugin through a personal or repo marketplace as documented by the current [OpenAI plugin packaging guide](https://developers.openai.com/plugins/build/plugins). No marketplace file is written automatically by this repository because that changes user or team Codex configuration. Validate the plugin itself with:

```bash
python C:/path/to/plugin-creator/scripts/validate_plugin.py packages/codex-integration/plugin/expert-council
```

The plugin's Main Agent guidance explicitly keeps final architecture and acceptance in Codex and avoids a redundant lead expert.

## Testing

```bash
npm test
npm run typecheck
npm run build
npm run pack:check
```

The deterministic suite covers model normalization, billing, Worker reliability, Oracle scoring, hard constraints, unknown and missing models, council sizing, retry, escalation, retry limits, role permissions, config validation, telemetry privacy/aggregation, Core host independence, mock Pi discovery/execution, CLI JSON, MCP schemas, and Pi extension registration.

Normal tests use mock runtimes and never call a paid model. Live provider invocation must be separately opt-in; none is performed by the supplied scripts.

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

- Pi APIs evolve quickly. V1 is verified against the installed 0.84.4 SDK. Upstream package resolution is capability-detected, but versions with materially different `ModelRuntime` or `createAgentSession` contracts fail with a clear diagnostic.
- Pi does not expose a universal real-world billing type. Unknown billing stays `unknown`; users must configure subscriptions, quotas, and promotional access.
- V1 does not infer subjective coding quality from model names or fetch benchmark presets.
- Detached worktrees start from committed `HEAD`; uncommitted Main Agent changes are not copied. This is intentional isolation and must be considered when forming the bounded task.
- Worktree changes are returned for review, not automatically merged or applied. Full host-native worktree handoff is not standardized across external MCP runtimes.
- Mutation in non-Git workspaces requires explicit in-place opt-in.
- MCP plan/execution status is process-local; durable outcomes are persisted, active jobs are not resumed after server restart.
- Skill discovery and hard tool restriction are available in the verified Pi SDK. On a future Pi build missing either feature, capabilities report the limitation; mutation is not silently weakened.
- Codex's own sandbox does not contain an external Pi runtime. Expert Council therefore enforces its separate allowed-root and worktree boundary.
- No arbitrary package installation, recursive expert trees, graphical UI, remote control plane, or remote analytics is included in V1.

## License

MIT. See [LICENSE](LICENSE).
