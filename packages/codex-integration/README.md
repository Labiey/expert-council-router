# Expert Council Codex integration

This private workspace package builds the Codex plugin found in
`plugin/expert-council`. The plugin contains the Codex-specific Skill and an MCP
server bundle backed by the shared Expert Council Core and Pi Runtime.

The plugin launch directory resolves the bundled server only. At runtime the server
uses the current Codex project's MCP file roots when available. On Codex versions
without MCP roots, a reviewed and trusted bundled `PreToolUse` hook records the
session `cwd` in `PLUGIN_DATA` immediately before the call. The server accepts only
the matching session record and never treats the installed plugin cache as the
repository.

From the repository root:

```powershell
npm run build
npm run smoke:codex
npm run smoke:installed-codex
```

See the repository [README](../../README.md#codex-plugin) for local plugin
installation, timeout configuration, testing, and removal instructions.
