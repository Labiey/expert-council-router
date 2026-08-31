import type { AvailableModel } from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === "string");
  return result.length ? result : undefined;
}

export function normalizePiModel(value: unknown, available = true): AvailableModel | undefined {
  const raw = record(value);
  const provider = typeof raw.provider === "string" ? raw.provider : undefined;
  const id = typeof raw.id === "string" ? raw.id : typeof raw.model === "string" ? raw.model : undefined;
  if (!provider || !id) return undefined;

  const cost = record(raw.cost ?? raw.apiCost);
  const thinkingMap = record(raw.thinkingLevelMap);
  const supportedReasoningLevels = Object.keys(thinkingMap).filter((key) => thinkingMap[key] !== null);
  const input = strings(raw.input ?? raw.inputModalities);

  return {
    provider,
    id,
    available,
    ...(typeof raw.name === "string" ? { displayName: raw.name } : {}),
    ...(typeof raw.family === "string" && raw.family.trim() ? { family: raw.family.trim() } : {}),
    ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
    ...(supportedReasoningLevels.length ? { supportedReasoningLevels } : {}),
    ...(number(raw.contextWindow) !== undefined ? { contextWindow: number(raw.contextWindow) } : {}),
    ...(number(raw.maxTokens ?? raw.maxOutputTokens) !== undefined
      ? { maxOutputTokens: number(raw.maxTokens ?? raw.maxOutputTokens) }
      : {}),
    ...(input ? { inputModalities: input } : {}),
    ...(Object.keys(cost).length
      ? {
          apiCost: {
            ...(number(cost.input ?? cost.inputPerMillion) !== undefined
              ? { inputPerMillion: number(cost.input ?? cost.inputPerMillion) }
              : {}),
            ...(number(cost.output ?? cost.outputPerMillion) !== undefined
              ? { outputPerMillion: number(cost.output ?? cost.outputPerMillion) }
              : {}),
            ...(number(cost.cacheRead ?? cost.cacheReadPerMillion) !== undefined
              ? { cacheReadPerMillion: number(cost.cacheRead ?? cost.cacheReadPerMillion) }
              : {}),
            ...(number(cost.cacheWrite ?? cost.cacheWritePerMillion) !== undefined
              ? { cacheWritePerMillion: number(cost.cacheWrite ?? cost.cacheWritePerMillion) }
              : {}),
          },
        }
      : {}),
    capabilities: {
      api: raw.api,
      baseUrlConfigured: typeof raw.baseUrl === "string" && raw.baseUrl.length > 0,
    },
    metadata: {
      source: "pi-runtime",
      samplingParamsConfigured: record(raw.samplingParams) && Object.keys(record(raw.samplingParams)).length > 0,
    },
  };
}

export function normalizePiModels(inputs: readonly unknown[], available = true): AvailableModel[] {
  const byKey = new Map<string, AvailableModel>();
  for (const input of inputs) {
    const model = normalizePiModel(input, available);
    if (model) byKey.set(`${model.provider}/${model.id}`, model);
  }
  return [...byKey.values()].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
}
