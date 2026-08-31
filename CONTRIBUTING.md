# Contributing to Expert Council

Expert Council is a TypeScript npm-workspace monorepo. Keep dependency direction one-way: `core` must remain host-independent; Pi, CLI, MCP, and distribution packages may depend on Core, never the reverse.

## Development

Requirements: Node.js 22.19 or newer, npm, Git, and Pi for local adapter checks.

```bash
npm install
npm run build
npm test
npm run typecheck
npm run pack:check
```

Normal tests must never invoke a paid model. Put live provider tests behind `EXPERT_COUNCIL_LIVE_TESTS=1`, make their expected spend explicit, and keep them out of `npm test`.

When changing routing, add deterministic tests for the intended ordering and rejection reason. Do not encode subjective model rankings as universal defaults. Use example presets or user configuration.

When changing the shared Skill, edit `shared/skills/expert-council/SKILL.md`, run `npm run build` to sync distribution copies, and validate it with the Codex skill validator. When changing the Codex plugin, run the plugin validator described in the root README.

## Pull requests

- Explain the user-visible behavior and security impact.
- Include tests for routing, permissions, retry, or schemas as appropriate.
- Keep expert output compact and do not add chain-of-thought capture.
- Do not add remote analytics, secret-bearing fixtures, or automatic third-party installation.
- Preserve bounded timeouts for any shell, server, or provider operation.
