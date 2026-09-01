import type { ExpertCouncil } from "../../packages/core/src/index.js";
import piExtension from "../../packages/pi-package/src/extension.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piHostExtension(pi: ExtensionAPI) {
  const council = (globalThis as typeof globalThis & {
    __expertCouncilPiHostTest?: ExpertCouncil;
  }).__expertCouncilPiHostTest;
  if (!council) throw new Error("Pi host integration test council was not configured");
  piExtension(pi, { councilFor: async () => council });
}
