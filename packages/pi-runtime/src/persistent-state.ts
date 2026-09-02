import type {
  CouncilStatePersistence,
  CouncilStateSnapshot,
  ModelAssessmentSnapshot,
} from "@expert-council/core";
import { JsonModelAssessmentStore } from "./file-assessment.js";
import { JsonCouncilStateStore } from "./file-state.js";

function combineState(
  workspaceState: CouncilStateSnapshot | undefined,
  sharedAssessment: ModelAssessmentSnapshot | undefined,
): CouncilStateSnapshot | undefined {
  if (!workspaceState && !sharedAssessment) return undefined;
  return {
    version: 1,
    plans: workspaceState?.plans ?? [],
    executions: workspaceState?.executions ?? [],
    results: workspaceState?.results ?? [],
    ...((sharedAssessment ?? workspaceState?.modelAssessment)
      ? { modelAssessment: sharedAssessment ?? workspaceState!.modelAssessment }
      : {}),
  };
}

export class SplitCouncilStateStore implements CouncilStatePersistence {
  constructor(
    private readonly workspace: JsonCouncilStateStore,
    private readonly assessment: JsonModelAssessmentStore,
  ) {}

  async load(): Promise<CouncilStateSnapshot | undefined> {
    const [workspaceState, sharedAssessment] = await Promise.all([
      this.workspace.load(),
      this.assessment.load(),
    ]);
    return combineState(workspaceState, sharedAssessment);
  }

  async save(
    snapshot: CouncilStateSnapshot,
    options: { replaceModelAssessment?: boolean } = { replaceModelAssessment: true },
  ): Promise<void> {
    const { modelAssessment, ...workspaceSnapshot } = snapshot;
    await Promise.all([
      this.workspace.save(workspaceSnapshot),
      ...(options.replaceModelAssessment && modelAssessment ? [this.assessment.save(modelAssessment)] : []),
    ]);
  }
}
