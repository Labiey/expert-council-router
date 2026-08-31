# Implement Expert Council — Dynamic Multi-Model Orchestration for Pi and Codex

You are the lead engineer responsible for designing and implementing this project end-to-end.

Do not merely produce an architecture document or scaffold. Inspect the current environment and current official APIs, implement a working V1, run tests, validate packaging, and leave the repository in a usable documented state.

The project is called **Expert Council**.

---

# 1. Project goal

Build a dynamic multi-model expert orchestration system.

The system allows a powerful Main Agent such as Codex to avoid wasting scarce high-quality model quota on routine work.

Before or during a significant task, Expert Council should:

1. discover the LLMs currently available through Pi;
2. discover their provider/access method and technical metadata;
3. combine API pricing with user-defined real billing policy;
4. load model capability and locally observed reliability profiles;
5. analyze the current task;
6. dynamically assemble a small expert team;
7. assign appropriate models to semantic roles;
8. give each expert only the tools and Skills it needs;
9. execute experts through Pi;
10. return compact structured results to the Main Agent;
11. retry or escalate intelligently when an expert fails;
12. record local outcome statistics to improve future routing.

The strongest theoretical model MUST NOT automatically be selected for every job.

Routing should optimize expected task success and effective cost.

A useful mental model is:

```text
effective value
=
capability
×
execution reliability
×
first-pass success probability
÷
effective marginal cost
```

Exact routing should use configurable deterministic scoring rather than this literal formula.

---

# 2. Important architectural decision

DO NOT implement this as one package that both Pi and Codex are expected to install natively.

Pi Packages and Codex plugins/integrations have different host-specific packaging and lifecycle requirements.

Instead implement:

```text
                    Expert Council Core
                           |
                     Pi Expert Runtime
                     /      |       \
                    /       |        \
             Pi Package    CLI     MCP Server
                                     |
                                     |
                              Codex integration
```

There must be:

* one shared platform-independent core;
* one Pi execution/runtime layer;
* a native Pi distribution;
* an MCP interface for Codex and other MCP-capable hosts;
* a Codex-facing distribution/integration;
* a CLI for development/debugging/fallback.

Business logic MUST NOT be duplicated between Pi and Codex integrations.

---

# 3. Main intended deployment

The most important deployment mode is:

```text
User
 |
 v
Codex
GPT-5.6 Sol/Terra
Main Agent / Lead
 |
 | MCP
 v
Expert Council
 |
 +-- inspect models
 +-- build council
 +-- select roles
 +-- apply cost policy
 +-- track failures
 |
 v
Pi Expert Runtime
 |
 +-- Qwen
 +-- GLM
 +-- Kimi
 +-- DeepSeek
 +-- local/custom models
 +-- future providers
```

Codex remains:

* Lead Engineer;
* final architectural authority;
* integration owner;
* final reviewer;
* acceptance owner.

Do NOT create another redundant `lead` subagent when Codex is the host.

Pi experts perform bounded delegated work.

The system must also support Pi itself acting as Main Agent through the Pi Package.

---

# 4. Repository architecture

Use a monorepo.

Use npm workspaces, pnpm workspaces, or another lightweight TypeScript monorepo solution appropriate to the current environment.

A desirable conceptual structure is:

```text
expert-council/
|
├─ packages/
|  |
|  ├─ core/
|  |  ├─ src/
|  |  |  ├─ inventory/
|  |  |  ├─ routing/
|  |  |  ├─ billing/
|  |  |  ├─ roles/
|  |  |  ├─ escalation/
|  |  |  ├─ telemetry/
|  |  |  ├─ config/
|  |  |  └─ types/
|  |  └─ package.json
|  |
|  ├─ pi-runtime/
|  |  ├─ src/
|  |  |  ├─ model-registry.ts
|  |  |  ├─ expert-executor.ts
|  |  |  ├─ skill-manager.ts
|  |  |  ├─ tool-manager.ts
|  |  |  └─ capabilities.ts
|  |  └─ package.json
|  |
|  ├─ pi-package/
|  |  ├─ extensions/
|  |  ├─ skills/
|  |  └─ package.json
|  |
|  ├─ mcp-server/
|  |  ├─ src/
|  |  └─ package.json
|  |
|  ├─ cli/
|  |  ├─ src/
|  |  └─ package.json
|  |
|  └─ codex-integration/
|     ├─ skills/
|     ├─ configuration/templates
|     └─ package metadata required by the CURRENT Codex ecosystem
|
├─ shared/
|  ├─ skills/
|  |  └─ expert-council/
|  |     └─ SKILL.md
|  |
|  └─ roles/
|     ├─ planner.md
|     ├─ scout.md
|     ├─ oracle.md
|     ├─ coder.md
|     ├─ debugger.md
|     ├─ reviewer.md
|     └─ verifier.md
|
├─ config/
|  └─ examples/
|
├─ tests/
|
├─ README.md
├─ CONTRIBUTING.md
├─ LICENSE
└─ package.json
```

This structure is conceptual.

Before committing to exact paths, inspect CURRENT Pi and Codex conventions.

Prefer current installed types and current official documentation over assumptions or stale examples.

---

# 5. Strict dependency boundaries

The dependency direction must remain clean.

Conceptually:

```text
core
 ↑
 |
pi-runtime
 ↑
 |
+---------------+
|               |
pi-package   mcp-server
                ↑
                |
          codex integration
```

The Core MUST NOT import:

* Pi extension APIs;
* Codex APIs;
* MCP transport-specific implementation;
* shell/process-specific implementation.

The Core should be unit-testable without launching an LLM.

---

# 6. Core interfaces

Define clean interfaces.

For example:

```ts
interface ExpertRuntime {
  listAvailableModels(): Promise<AvailableModel[]>;

  executeExpert(
    request: ExpertExecutionRequest
  ): Promise<ExpertExecutionResult>;

  listSkills(): Promise<SkillInfo[]>;

  getCapabilities(): Promise<RuntimeCapabilities>;
}
```

And a host-independent Expert Council service similar to:

```ts
interface ExpertCouncil {
  inspectResources(): Promise<ResourceInventory>;

  buildCouncil(
    request: BuildCouncilRequest
  ): Promise<CouncilPlan>;

  delegate(
    request: DelegationRequest
  ): Promise<ExpertResult>;

  escalate(
    request: EscalationRequest
  ): Promise<EscalationDecision>;

  getStatus(): Promise<CouncilStatus>;

  recordOutcome(
    outcome: ExpertOutcome
  ): Promise<void>;
}
```

Exact APIs may differ, but preserve this separation.

---

# 7. Dynamic model discovery

Do not maintain a hardcoded list of models.

Use Pi's CURRENT supported model registry APIs to discover actually available/authenticated models.

Inspect the installed Pi version and types before implementation.

Normalize model metadata into an internal structure similar to:

```ts
interface AvailableModel {
  provider: string;
  id: string;
  displayName?: string;

  reasoning?: boolean;

  contextWindow?: number;
  maxOutputTokens?: number;

  inputModalities?: string[];

  apiCost?: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
  };

  billingProfile?: string;

  capabilities?: Record<string, unknown>;

  metadata?: Record<string, unknown>;
}
```

A model definition existing somewhere in configuration does NOT necessarily mean it is callable.

Prefer discovery of currently usable models.

---

# 8. Billing model

Published API pricing is not enough.

Users may access models through:

* subscription plans;
* token plans;
* fixed quotas;
* metered APIs;
* free/local inference;
* promotional credits;
* unknown billing arrangements.

Implement a user-defined Billing Policy.

Example:

```json
{
  "providers": {
    "qwen-token-plan": {
      "billingType": "subscription",
      "marginalCostClass": "very-low",
      "usagePreference": "consume-first"
    },

    "zai-official": {
      "billingType": "metered",
      "marginalCostClass": "normal",
      "usagePreference": "quality-sensitive"
    },

    "openai-codex": {
      "billingType": "quota",
      "marginalCostClass": "scarce",
      "usagePreference": "escalation-only"
    }
  }
}
```

Support at least:

```text
subscription
metered
quota
free
unknown
```

Do not hardcode the user's current Qwen/GLM arrangement.

Provide it only as an example configuration.

---

# 9. Capability and reliability profiles

Model selection must consider more than official benchmark strength.

Support configurable dimensions such as:

```text
reasoning
planning
architecture
coding
debugging
review
longContext
toolReliability
bashReliability
autonomousExecution
speed
```

Example user profile:

```json
{
  "models": {
    "qwen-token-plan/qwen3.8-max": {
      "planning": 9,
      "architecture": 9,
      "coding": 7,
      "debugging": 7,
      "review": 9,
      "longContext": 9,
      "toolReliability": 5,
      "bashReliability": 6,
      "autonomousExecution": 6
    },

    "zai/glm-5.3-flash": {
      "planning": 7,
      "architecture": 7,
      "coding": 8,
      "debugging": 8,
      "review": 8,
      "longContext": 8,
      "toolReliability": 9,
      "bashReliability": 9,
      "autonomousExecution": 9
    }
  }
}
```

These are EXAMPLE USER VALUES only.

Do not publish them as objective benchmark facts.

Public distributions should use conservative generic defaults.

Users must be able to override profiles without changing source code.

---

# 10. Profile hierarchy

Separate profile information into:

```text
objective runtime metadata
        +
optional shipped presets/examples
        +
user overrides
        +
local observed performance
```

Suggested precedence:

```text
built-in conservative defaults
<
optional preset
<
user configuration
<
runtime/task override
```

Locally learned data should influence routing conservatively.

Explicit user configuration remains authoritative.

---

# 11. Semantic expert roles

Model names must NOT define roles.

Implement semantic roles.

At minimum:

## Planner

Purpose:

* task decomposition;
* implementation planning;
* dependency analysis;
* risk identification.

Usually read-only.

---

## Scout

Purpose:

* repository exploration;
* locating files;
* finding symbols;
* tracing dependencies;
* compressing repository context.

Default tools should be similar to:

```text
read
grep
find
ls
```

No mutation.

Prefer inexpensive models.

---

## Architecture Oracle

Purpose:

* difficult architectural reasoning;
* cross-file reasoning;
* second opinion;
* design review;
* large-context analysis.

Usually read-only.

This role is ideal for a powerful low-marginal-cost model that may not be the most reliable autonomous file editor.

---

## Implementation Worker

Purpose:

* perform bounded code modifications;
* inspect relevant files;
* implement;
* run focused tests;
* inspect the resulting changes.

Strongly weight:

```text
tool reliability
coding
bash reliability
autonomous execution
first-pass success
```

---

## Debugger

Purpose:

* reproduce failures;
* inspect logs;
* isolate root cause;
* formulate and implement fixes;
* verify results.

---

## Reviewer

Purpose:

* inspect another expert's implementation;
* identify regressions;
* identify incorrect assumptions;
* identify edge cases;
* evaluate architectural quality.

Prefer a different model family from the worker when economical.

Default read-only.

---

## Verifier

Purpose:

* run tests;
* inspect diffs/results;
* validate acceptance criteria;
* report pass/failure.

Tool reliability matters more than elite abstract reasoning.

---

# 12. Dynamic council size

Do not spawn all roles for every task.

A tiny task may need:

```text
Main Agent
+
Worker
```

A normal task may need:

```text
Main Agent
+
Worker
+
Verifier
```

A complex feature may use:

```text
Main Agent
+
Planner/Oracle
+
Worker
+
Reviewer
+
Verifier
```

A difficult bug may use:

```text
Main Agent
+
Scout
+
Debugger
+
Oracle if needed
+
Verifier
```

The expected contribution of an expert must justify its token/cost overhead.

---

# 13. Deterministic role scoring

Do not ask the Main Agent to repeatedly calculate rankings itself.

Implement deterministic scoring in Core.

Example conceptual weighting for an implementation worker:

```text
toolReliability        30%
coding                 25%
autonomousExecution    15%
bashReliability        10%
debugging               5%
costEfficiency         10%
speed                    5%
```

Architecture Oracle may instead emphasize:

```text
architecture           30%
planning               20%
longContext            20%
review                 15%
reasoning              10%
costEfficiency          5%
```

Make weights configurable.

Routing procedure should approximately be:

```text
discover candidates
        ↓
apply hard constraints
        ↓
calculate role scores
        ↓
apply billing policy
        ↓
apply local reliability adjustment
        ↓
rank candidates
        ↓
return selected model + alternatives + reason
```

---

# 14. Hard constraints

Rules should prevent obviously bad assignments before LLM judgment.

Examples:

```text
disabled model
→ reject

role requires mutation but runtime cannot provide mutation
→ reject

tool reliability below configured threshold
→ reject as autonomous worker

insufficient context window
→ reject for long-context assignment

billing preference = escalation-only
→ reject for routine task

known incompatible provider/runtime capability
→ reject or strongly penalize
```

Rules prevent bad decisions.

The Main Agent handles ambiguity.

---

# 15. Reasoning levels

Reasoning effort is model/provider-specific.

Do NOT assume every model supports:

```text
low
medium
high
xhigh
max
```

Discover supported settings where possible.

Profiles may define preferred reasoning effort per role/model.

The system must gracefully handle unsupported reasoning levels.

---

# 16. Expert execution

Pi should remain the initial expert runtime.

Reuse Pi's existing subagent infrastructure where reliable and appropriate.

Do not build a second complete LLM agent harness unless necessary.

However, hide Pi-specific execution details behind `ExpertRuntime`.

Prevent uncontrolled recursive delegation.

Default topology:

```text
Main Agent
 |
 +-- Expert
 |
 +-- Expert
 |
 +-- Expert
```

Do not permit arbitrary:

```text
Expert
 -> Expert
   -> Expert
     -> Expert
```

unless a future explicitly controlled feature adds it.

---

# 17. Tool least privilege

Experts must receive only the tools required by their role.

Default examples:

```text
Planner / Scout / Oracle / Reviewer
read
grep
find
ls
```

Implementation Worker:

```text
read
grep
find
ls
edit
write
bash
```

Verifier:

```text
read
grep
find
ls
bash
```

Use actual Pi runtime mechanisms for hard restriction where supported.

Prompt-based restrictions are a fallback, not equivalent to removing the tool.

---

# 18. File operation discipline

Mutation-capable expert prompts must include rules equivalent to:

```text
Never modify an existing file before inspecting the relevant content.

Prefer targeted edit/patch operations over rewriting whole existing files.

Do not guess a path when it can be verified.

Establish the project working directory when uncertain.

After modification, inspect the changed content or diff.

If a tool call fails, diagnose the cause before retrying.

Never blindly repeat an identical failed tool call.

Run appropriate focused tests before reporting success.
```

---

# 19. Skills and resource management

Support role-specific Skill assignment.

Examples:

```text
Oracle
→ architecture-analysis

Worker
→ coding
→ testing
→ safe-shell

Reviewer
→ code-review
```

Do not inject all available Skills into every expert.

Discover installed resources where current Pi APIs permit it.

---

# 20. Package/plugin installation security

V1 MUST NOT autonomously install arbitrary executable third-party extensions.

Default policy:

```text
already-installed Skill
→ may activate automatically

installed but disabled trusted Skill
→ may activate automatically

new pure Skill
→ configurable / request approval

third-party extension containing executable code
→ explicit user approval required

unknown/untrusted package
→ do not automatically install
```

Treat extension installation as a security boundary.

Never install code merely because an LLM recommends it.

---

# 21. Retry and escalation

Implement bounded retry/escalation.

Distinguish failures such as:

```text
tool_call_error
reasoning_failure
test_failure
timeout
provider_error
missing_context
permission_error
```

Suggested behavior:

```text
first simple execution failure
→ one corrected retry if appropriate

same model repeatedly fails
→ escalate to next candidate

provider outage
→ use compatible alternative if configured

maximum escalation reached
→ return unresolved state to Main Agent
```

Never loop indefinitely.

Do not keep using the same model if evidence indicates the model/runtime combination is the problem.

---

# 22. Structured expert results

Experts should not flood Main Agent context.

Normalize output approximately as:

```ts
interface ExpertResult {
  status: "success" | "partial" | "failed";

  role: string;
  model: string;

  summary: string;

  filesChanged?: string[];

  tests?: Array<{
    command?: string;
    status: "passed" | "failed" | "not-run";
    summary?: string;
  }>;

  findings?: string[];

  risks?: string[];

  recommendedNextAction?: string;

  executionMetadata?: {
    attempts?: number;
    failureType?: string;
    usage?: unknown;
  };
}
```

Do NOT request or store private chain-of-thought.

Return only actionable conclusions.

---

# 23. Context/token efficiency

This project exists partly to reduce expensive Main Agent context use.

Expert output should therefore be concise.

Scout should return:

```text
relevant files
important symbols
call/dependency chain
key findings
recommended next action
```

Worker should return:

```text
files changed
tests
key decisions
remaining risks
```

Do not copy entire source files into expert output when Main Agent can inspect the diff.

Reviewer should prioritize:

```text
BLOCKER
MAJOR
MINOR
PASS
```

with concise explanations.

---

# 24. Mutation isolation for Codex host

Do NOT assume Codex's sandbox automatically protects work performed by an external MCP/Pi runtime.

Implement an explicit execution safety strategy.

V1 should support or clearly prepare for isolated worker execution using Git worktrees or another controlled workspace mechanism.

Preferred conceptual flow:

```text
Codex main workspace
       |
       +-- read-only experts inspect it
       |
       +-- mutation expert receives isolated worktree
                     |
                     v
                  changes
                     |
                tests + diff
                     |
                     v
             structured result
                     |
                     v
            Codex reviews changes
```

Do not silently allow arbitrary worker writes outside permitted workspace boundaries.

If full worktree isolation is too large for initial V1, implement a clear workspace boundary and architecture that allows worktree isolation to be added without rewriting Core.

Document limitations explicitly.

---

# 25. Telemetry and local learning

Implement a basic local outcome store.

Track aggregates such as:

```text
model
provider
role
task category
success/failure
tool errors
retry count
timeouts
verification result
escalation count
approximate usage if available
host type
```

Do not record:

* chain of thought;
* secrets;
* API keys;
* unnecessary source content;
* private prompts beyond what is required.

Derived metrics may include:

```text
success rate by role
first-pass success
tool reliability
retry rate
verification pass rate
average attempts per successful task
```

Automatic profile adaptation must be conservative.

Explicit user overrides win.

Telemetry is local by default.

No remote analytics in V1.

---

# 26. Shared Skill

Create a platform-neutral Agent Skill source.

It should teach the host Main Agent:

```text
Use Expert Council when delegation is likely to save
significant context, execution effort, or cost.

Do not delegate trivial work merely because experts exist.

Delegate bounded semantic tasks by role.

Keep architectural authority and final acceptance in the Main Agent.

Use read-only experts for investigation where possible.

Do not redo successful expert work without evidence that it is wrong.

Verify important mutation results.

Escalate expensive/scarce models only when justified.
```

Avoid Pi-specific wording in the shared source where possible.

Package/adapt it according to current Pi and Codex conventions.

---

# 27. Role prompts

Keep role prompts platform-independent and shared.

For example, `coder.md` should describe implementation-worker behavior without mentioning whether the caller is Pi or Codex.

Do not duplicate role prompts across distributions.

---

# 28. MCP interface

Expose a deliberately small semantic MCP surface.

Prefer approximately:

## `expert_inspect`

Returns compact normalized information about:

* models;
* providers;
* billing;
* roles;
* runtime capabilities.

---

## `expert_build`

Input:

```json
{
  "task": "...",
  "constraints": {
    "maxExperts": 4,
    "costPolicy": "balanced"
  }
}
```

Output:

```json
{
  "taskClass": "complex-debugging",
  "experts": [
    {
      "role": "architecture-oracle",
      "model": "...",
      "reason": ["..."]
    },
    {
      "role": "implementation-worker",
      "model": "...",
      "reason": ["..."]
    }
  ]
}
```

---

## `expert_delegate`

Input should primarily specify semantic role and bounded task.

The host should normally NOT need to manually select provider/model after the council is built.

---

## `expert_escalate`

Escalates according to policy and previous failure.

---

## `expert_status`

Returns current task/council execution state.

---

Do NOT expose dozens of internal low-level configuration operations as MCP tools.

Keep host tool selection simple.

---

# 29. CLI

Provide a structured CLI using the same Core and Pi Runtime.

Examples conceptually:

```bash
expert-council models

expert-council inspect

expert-council build "fix the device hot-swap race condition"

expert-council delegate oracle "analyze the concurrency path"

expert-council status
```

Support machine-readable JSON output.

CLI is important for:

* development;
* testing;
* debugging;
* scripting;
* fallback integration.

Do not implement separate routing logic in CLI.

---

# 30. Native Pi distribution

Create a proper native Pi Package using CURRENT Pi Package conventions.

It should expose Expert Council tools to a Pi Main Agent and load the shared Expert Council Skill.

A Pi user should ultimately be able to install the Pi distribution normally.

Do not assume package manifest syntax from memory.

Inspect current Pi docs/types.

---

# 31. Codex distribution

Codex integration must follow CURRENT Codex plugin/MCP/Skill conventions.

Do not assume it uses the same format as Pi.

The Codex distribution should primarily:

* install/reference the shared host guidance/Skill as appropriate;
* configure or expose the Expert Council MCP server;
* provide sensible setup instructions;
* avoid duplicating Core logic.

Codex communicates to experts through MCP.

Pi remains the initial expert execution backend.

---

# 32. Public/open-source readiness

Design V1 as a public project, not a personal script.

Do not hardcode:

* local absolute paths;
* personal API keys;
* specific user provider setup;
* Qwen/GLM role choices;
* local reliability scores.

All personal information must live in user config ignored by Git/npm.

Provide:

```text
*.example.json
```

for public examples.

Include proper:

```text
.gitignore
npm package file allowlists
LICENSE
README
CONTRIBUTING
```

No secrets or local telemetry should be publishable accidentally.

---

# 33. Public presets

It is acceptable to provide optional example presets such as:

```text
subscription-heavy
metered-quality
balanced
```

and an example showing:

```text
Qwen Token Plan + GLM metered API
```

but clearly label them as examples.

Do not claim subjective local reliability ratings as universal benchmark facts.

---

# 34. Compatibility

Pi and Codex evolve rapidly.

Implement capability detection where possible.

Do not crash unnecessarily because an optional host API is unavailable.

Examples:

```text
Pi model discovery available        yes/no
hard tool restriction available     yes/no
skill override available            yes/no
subagent backend available          yes/no
```

Use graceful fallback only when safe.

Document degradation.

Current installed APIs and types are the source of truth.

---

# 35. Shell execution safety

Any command that may block, wait for input, watch files, start a server, stream indefinitely, or otherwise hang MUST use a finite timeout or appropriate managed background execution.

Prefer non-interactive options.

Choose timeouts according to expected runtime.

After timeout/failure:

```text
inspect error
→ diagnose
→ change approach
```

Do not blindly repeat the same command.

Apply this rule during development as well as in the runtime.

---

# 36. Testing

Implement deterministic automated tests.

At minimum cover:

## Model normalization

Different Pi model metadata should normalize safely.

## Billing policy

Subscription/free models should receive favorable cost scoring where appropriate.

## Tool reliability

A high-reasoning but low-tool-reliability model should lose to a reliable model for autonomous implementation when weights require it.

## Oracle scoring

A strong long-context subscription model can beat an execution-focused model for architecture/oracle work.

## Hard constraints

Models incapable of role requirements are eliminated.

## Unknown models

New models without local profiles receive conservative defaults.

## Missing configured models

A profile referencing an unavailable model does not crash routing.

## Dynamic council size

Simple tasks produce smaller councils.

## Retry

One correctable failure does not immediately trigger unnecessary expensive escalation.

## Escalation

Repeated relevant failures move to the next suitable model.

## Retry limit

Execution terminates rather than looping.

## Permission policy

Read-only roles do not receive mutation tools by default.

## Config validation

Invalid config returns clear actionable errors.

## Telemetry

Outcome aggregation works without storing sensitive reasoning content.

## Host independence

Core tests run without Pi or Codex.

---

# 37. Integration tests

Where practical, create integration tests or test harnesses for:

```text
Core + mock ExpertRuntime

Core + Pi runtime discovery

CLI JSON interface

MCP tool schemas

Pi adapter registration
```

Real paid-model invocation tests should NOT be required for the normal test suite.

Put live tests behind explicit opt-in environment flags.

Never spend user API credits automatically during ordinary tests.

---

# 38. Documentation

README must explain:

```text
what Expert Council is

why strongest-model-everywhere is inefficient

architecture

Pi vs Codex distributions

installation

model discovery

billing profiles

capability profiles

role system

routing

Skills

tool permissions

retry/escalation

telemetry

security boundaries

configuration examples

MCP setup

CLI usage

Pi installation

Codex installation

development

testing

publishing
```

Include a simple architecture diagram.

Include a quick-start path with conservative defaults.

The project should ideally be usable before the user manually fills a giant configuration file.

---

# 39. Zero-config philosophy

Aim for:

```text
install
↓
discover models
↓
use conservative defaults
↓
work
```

Advanced users can then configure:

```text
billing
profiles
routing weights
role limits
security
```

If billing mode cannot be inferred safely, classify it as unknown instead of guessing.

---

# 40. Development sequence

Implement incrementally.

Recommended order:

```text
Phase 1
repository inspection
API verification
monorepo scaffold

Phase 2
Core types/config schemas

Phase 3
model normalization + mock inventory

Phase 4
billing/profile/routing scoring

Phase 5
roles + council builder

Phase 6
retry/escalation

Phase 7
telemetry

Phase 8
PiExpertRuntime model discovery

Phase 9
Pi expert execution adapter

Phase 10
CLI

Phase 11
Pi Package adapter

Phase 12
MCP server

Phase 13
Codex integration/distribution

Phase 14
security/workspace boundaries

Phase 15
integration tests

Phase 16
documentation and package validation
```

After each independently testable phase:

```text
run relevant tests
run typecheck/lint if configured
inspect the diff
fix regressions
then continue
```

Do not allow the project to accumulate a large unverified diff.

---

# 41. Development model delegation

You are the Main Developer and architectural authority.

If a working local Pi installation is available and delegating clearly reduces your own context or repetitive workload, you MAY use Pi models for bounded non-critical subwork.

Recommended development policy:

```text
GLM-5.3-Flash
→ implementation helper
→ repetitive modules
→ unit tests
→ boilerplate
→ focused bug fixes

Qwen3.8-Max
→ read-only architecture second opinion
→ API/design review
→ code review
→ long-context analysis
```

Do NOT delegate:

```text
fundamental architecture ownership
security-boundary decisions
final API design approval
final integration acceptance
```

unless you independently verify the result.

Do not assume these model names exist.

Discover the actual local Pi models first.

If Pi delegation is unreliable or unavailable, continue development yourself rather than blocking.

---

# 42. Important design philosophy

Follow these principles:

```text
LLMs handle ambiguous judgment.
Code handles deterministic state and arithmetic.

Rules prevent obviously bad routing.
Main Agent handles ambiguous routing.

The cheapest model is not automatically best.
The strongest model is not automatically best.

First-pass reliability matters.

Context is a cost.

Every expert should have a bounded purpose.

Main Agent retains final acceptance.

Least privilege applies to agents.

External worker execution must have its own security boundary.
```

---

# 43. Non-goals for V1

Do NOT spend significant time on:

```text
graphical UI
cloud-hosted control plane
distributed remote agents
machine-learning router training
autonomous marketplace crawling
automatic untrusted plugin installation
recursive arbitrary agent trees
complex billing dashboards
```

Keep V1 focused.

---

# 44. V1 acceptance criteria

V1 is complete only when the following conceptual scenario works:

A user has multiple models configured in Pi.

The user starts Codex and asks it to implement a substantial feature.

Codex can:

```text
1. call Expert Council through MCP;

2. inspect available expert resources;

3. build an expert council based on:
   - task type,
   - model capability,
   - local reliability,
   - billing policy,
   - role requirements;

4. delegate a bounded analysis/coding/debugging/review task;

5. have the expert execute through Pi;

6. enforce appropriate role resource permissions;

7. receive a concise structured result;

8. retry or escalate if needed;

9. verify/integrate the result;

10. finish without recursive delegation loops.
```

Separately, Pi should be able to act as host Main Agent through its native Pi Package distribution using the same Core logic.

And CLI must be capable of independently exercising the same Core/runtime for debugging.

---

# 45. Required final deliverables

Do not stop until the repository contains, to the extent supported by the current APIs:

```text
working monorepo

shared ExpertCouncil Core

PiExpertRuntime

routing/scoring implementation

billing configuration

performance profile configuration

semantic roles

shared Agent Skill

retry/escalation

local telemetry

CLI

native Pi Package

MCP server

Codex integration/distribution

tests

example configurations

README

security documentation

development/publishing documentation
```

Run the relevant automated tests.

Run type checking.

Validate package manifests.

Perform package/dry-run validation where appropriate.

Report any feature that cannot be implemented because the CURRENT Pi or Codex API lacks the necessary capability.

Do NOT fake unsupported functionality.

When an API limitation exists:

```text
document the limitation
implement the safest reasonable fallback
preserve an interface for future support
```

---

# 46. Working behavior

Begin by inspecting:

```text
the current repository
installed Pi version
Pi package APIs
Pi extension APIs
Pi model registry
Pi subagent/runtime support
Pi Skill conventions
Codex current integration/plugin/Skill conventions
MCP support
available TypeScript types
```

Do not rely on old documentation or remembered API signatures when current code/types are available.

Then create a concise internal implementation plan and start coding immediately.

Do not ask me to manually choose routine implementation details that can be resolved from the environment and project goals.

Make sensible engineering decisions.

Keep the implementation simple, modular, testable, and publishable.

Most importantly:

**Do not merely describe Expert Council. Build it.**