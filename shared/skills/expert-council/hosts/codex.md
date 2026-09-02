## Codex and non-push MCP completion behavior

After dispatching the complete batch and finishing independent work, call `expert_wait` once with the execution IDs, normally using `mode: "all"`, or `"any"` only when one early result can advance the task. Set an explicit finite `timeoutMs` from the expected remaining work. Blocking in this call is intentional: it keeps the host turn alive without polling or spending Main Agent tokens. If the bounded wait expires, reassess before waiting again, then retrieve reported executions with `expert_result`.

Choose `expert_delegate.timeoutMs` for every assignment from its expected difficulty. Give potentially blocking Bash, PowerShell, and MCP calls an explicit finite, difficulty-based timeout whenever their schemas support one. The Codex MCP transport ceiling is only a safety envelope and must not be treated as the operation's execution budget.
