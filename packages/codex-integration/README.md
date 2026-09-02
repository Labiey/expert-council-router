# Expert Council Codex integration

This private workspace package builds the Codex plugin found in
`plugin/expert-council`. The plugin contains the Codex-specific Skill and an MCP
server bundle backed by the shared Expert Council Core and Pi Runtime.

From the repository root:

```powershell
npm run build
npm run smoke:codex
npm run smoke:installed-codex
```

See the repository [README](../../README.md#codex-plugin) for local plugin
installation, timeout configuration, testing, and removal instructions.
