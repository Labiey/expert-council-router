---
name: expert-council
description: Use a cost-aware Pi expert council for substantial bounded investigation, implementation, debugging, review, or verification when delegation is likely to save meaningful context, execution effort, or scarce-model quota. Do not use for trivial work.
---

# Expert Council

Use Expert Council only when delegation is likely to save significant context, execution effort, or effective cost.

1. For a substantial host task, call `expert_inspect` when current resources or limitations are unknown, then call `expert_build` with the task and relevant cost or size constraints.
2. Delegate bounded semantic assignments by role with `expert_delegate`. It starts background work and immediately returns an `executionId`. Add a short `taskDescription` when recognizing the task later would help; completion notifications contain that description only when supplied.
3. In the native Pi Package, a finished background expert automatically reawakens the Main Agent. After dispatching experts or finishing other useful work, end the current turn normally instead of polling, consuming tokens in a silent wait, or inventing placeholder work. Hosts without completion push may query `expert_status` when they next run.
4. When a completion notification names an `executionId`, call `expert_result` with that exact ID before using the expert feedback. A notification contains only the ID and optional task description, never the feedback itself.
5. Prefer read-only investigation before mutation when it reduces risk. Keep architecture, integration decisions, and final acceptance in the Main Agent. When Codex is the host, do not create a redundant lead expert.
6. Give each expert a narrow purpose. Do not delegate trivial work merely because experts exist, and do not permit recursive expert delegation.
7. Accept concise successful expert work unless evidence shows it is wrong. Verify important mutation results and inspect isolated worktree changes before integration.
8. Use `expert_escalate` only with structured failure evidence. Escalate scarce or expensive models when corrected retry or economical alternatives are insufficient.

Do not request private reasoning. Use summaries, changed files, tests, findings, risks, and recommended next actions.
