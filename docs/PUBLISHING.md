# Publishing Checklist

1. Ensure the working tree contains no `.env`, personal config, `.expert-council/telemetry.jsonl`, Pi settings, credentials, or generated worktrees.
2. Update all public workspace package versions consistently.
3. Run `npm install` so the lockfile reflects the manifests.
4. Run `npm run validate`.
5. Inspect each dry-run tarball. Confirm only `dist`, package documentation, Skills, and intended manifests are present.
6. Publish `core`, then `pi-runtime`, then consumers (`cli`, `mcp-server`, `pi-package`).
7. Install each published artifact in a fresh temporary project and repeat model discovery without provider invocation.
8. Validate the Pi package with `pi -e npm:@expert-council/pi-package --list-models`.
9. Rebuild and validate the Codex plugin. Add factual publisher, repository, privacy, support, and terms metadata before catalog submission.
10. Test Codex installation through an isolated local marketplace and a new task. Confirm `expert_inspect` works before invoking any paid model.

Public example profiles must remain clearly labeled as examples. Do not turn one user's observed model reliability into an objective preset.
