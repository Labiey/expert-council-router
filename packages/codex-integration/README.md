# Expert Council Codex integration

This private workspace package builds the Codex plugin found in
`plugin/expert-council`. The plugin contains the Codex-specific Skill and an MCP
server bundle backed by the shared Expert Council Core and Pi Runtime. The
release artifact also bundles the tested Pi SDK runtime, so a Git Marketplace
install does not resolve SDK modules from the user's global npm directory.

The plugin launch directory resolves the bundled server only. At runtime the server
uses the current Codex project's MCP file roots when available, then Codex's
host-owned `codex/sandbox-state-meta` request metadata. The latter supplies the
current sandbox working directory and permission profile without requiring a hook
or manual workspace configuration. The server never treats the installed plugin
cache as the repository.

From the repository root:

```powershell
npm run build
npm run smoke:codex
npm run smoke:installed-codex
```

See the repository [README](../../README.md#codex-plugin) for local plugin
installation, timeout configuration, testing, and removal instructions.
