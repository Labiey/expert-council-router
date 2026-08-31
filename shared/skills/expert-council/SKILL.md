---
name: expert-council
description: Use a cost-aware Pi expert council for substantial bounded investigation, implementation, debugging, review, or verification when delegation is likely to save meaningful context, execution effort, or scarce-model quota. Do not use for trivial work.
---

# Expert Council

Use Expert Council only when delegation is likely to save significant context, execution effort, or effective cost.

1. For a substantial host task, call `expert_inspect` when current resources or limitations are unknown, then call `expert_build` with the task and relevant cost or size constraints.
2. Delegate bounded semantic assignments by role with `expert_delegate`. Prefer read-only investigation before mutation when it reduces risk.
3. Keep architecture, integration decisions, and final acceptance in the Main Agent. When Codex is the host, do not create a redundant lead expert.
4. Give each expert a narrow purpose. Do not delegate trivial work merely because experts exist, and do not permit recursive expert delegation.
5. Accept concise successful expert work unless evidence shows it is wrong. Verify important mutation results and inspect isolated worktree changes before integration.
6. Use `expert_escalate` only with structured failure evidence. Escalate scarce or expensive models when corrected retry or economical alternatives are insufficient.

Do not request private reasoning. Use summaries, changed files, tests, findings, risks, and recommended next actions.
