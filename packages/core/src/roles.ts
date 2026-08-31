import type { ExpertRole, RoleDefinition } from "./types.js";

const readOnlyTools = ["read", "grep", "find", "ls"];

export const DEFAULT_ROLES: Record<ExpertRole, RoleDefinition> = {
  planner: {
    role: "planner",
    description: "Decompose tasks, dependencies, risks, and acceptance criteria.",
    readOnly: true,
    tools: readOnlyTools,
    skills: ["planning"],
    weights: { planning: 0.3, reasoning: 0.2, architecture: 0.15, longContext: 0.15, review: 0.1, costEfficiency: 0.1 },
  },
  scout: {
    role: "scout",
    description: "Explore repositories and compress relevant context without mutation.",
    readOnly: true,
    tools: readOnlyTools,
    skills: [],
    weights: { toolReliability: 0.25, longContext: 0.15, speed: 0.2, reasoning: 0.1, autonomousExecution: 0.1, costEfficiency: 0.2 },
  },
  "architecture-oracle": {
    role: "architecture-oracle",
    description: "Provide difficult cross-file architectural reasoning and a second opinion.",
    readOnly: true,
    tools: readOnlyTools,
    skills: ["architecture-analysis"],
    weights: { architecture: 0.3, planning: 0.2, longContext: 0.2, review: 0.15, reasoning: 0.1, costEfficiency: 0.05 },
  },
  "implementation-worker": {
    role: "implementation-worker",
    description: "Perform bounded code changes and focused validation.",
    readOnly: false,
    requiresMutation: true,
    tools: ["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"],
    skills: ["coding", "testing", "safe-shell"],
    minimumToolReliability: 4,
    weights: {
      toolReliability: 0.3,
      coding: 0.25,
      autonomousExecution: 0.15,
      bashReliability: 0.1,
      debugging: 0.05,
      costEfficiency: 0.1,
      speed: 0.05,
    },
  },
  debugger: {
    role: "debugger",
    description: "Reproduce failures, isolate root causes, fix them, and verify results.",
    readOnly: false,
    requiresMutation: true,
    tools: ["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"],
    skills: ["debugging", "testing", "safe-shell"],
    minimumToolReliability: 4,
    weights: { debugging: 0.3, toolReliability: 0.25, coding: 0.15, bashReliability: 0.1, reasoning: 0.1, costEfficiency: 0.05, speed: 0.05 },
  },
  reviewer: {
    role: "reviewer",
    description: "Review another expert's changes for correctness, regressions, and design quality.",
    readOnly: true,
    tools: readOnlyTools,
    skills: ["code-review"],
    weights: { review: 0.3, reasoning: 0.2, architecture: 0.15, coding: 0.15, longContext: 0.1, costEfficiency: 0.1 },
  },
  verifier: {
    role: "verifier",
    description: "Run tests and validate diffs and acceptance criteria without editing.",
    readOnly: true,
    tools: ["read", "grep", "find", "ls", "bash", "powershell"],
    skills: ["testing"],
    minimumToolReliability: 4,
    weights: { toolReliability: 0.3, bashReliability: 0.25, autonomousExecution: 0.15, debugging: 0.1, speed: 0.1, costEfficiency: 0.1 },
  },
};

export function getRole(role: ExpertRole): RoleDefinition {
  return DEFAULT_ROLES[role];
}

export function listRoles(): RoleDefinition[] {
  return Object.values(DEFAULT_ROLES).map((role) => ({ ...role, tools: [...role.tools], skills: [...role.skills] }));
}
