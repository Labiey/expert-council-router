import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExpertCouncil } from "../packages/pi-runtime/dist/index.js";

if (process.env.EXPERT_COUNCIL_LIVE_CONFIRM !== "YES") {
  throw new Error("Live Pi smoke test is disabled. Set EXPERT_COUNCIL_LIVE_CONFIRM=YES to acknowledge provider usage.");
}

const targetModel = process.env.EXPERT_COUNCIL_LIVE_MODEL;
if (!targetModel?.includes("/")) {
  throw new Error("Set EXPERT_COUNCIL_LIVE_MODEL to an explicit provider/model before running the live smoke test.");
}

const temporary = await mkdtemp(path.join(tmpdir(), "expert-council-live-"));
try {
  const council = await createExpertCouncil({
    cwd: process.cwd(),
    telemetryPath: path.join(temporary, "telemetry.jsonl"),
    statePath: path.join(temporary, "state.json"),
  });
  const inventory = await council.inspectResources();
  const available = inventory.models.map((model) => `${model.provider}/${model.id}`);
  if (!available.includes(targetModel)) {
    throw new Error(`Requested live model ${targetModel} is not callable. Available models: ${available.join(", ")}`);
  }
  const modelOverrides = Object.fromEntries(available.map((model) => [model, { disabled: model !== targetModel }]));
  const result = await council.delegate({
    role: "scout",
    task: "Inspect package.json and return a concise structured summary of the repository package name. Do not modify files.",
    timeoutMs: 120_000,
    constraints: { modelOverrides },
  });
  if (result.status !== "success") {
    throw new Error(`Live Pi execution did not succeed: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify({ model: result.model, status: result.status, usage: result.executionMetadata?.usage })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
