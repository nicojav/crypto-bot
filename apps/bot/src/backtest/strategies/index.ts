import { emaCross } from "./emaCross.js";
import { emaCrossTpSl } from "./emaCrossTpSl.js";
import { emaRsiPctTpSl } from "./emaRsiPctTpSl.js";
import { customMaCross } from "./customMaCross.js";
import type { StrategyDefinition } from "./types.js";

export type { StrategyDefinition, StrategyParamDef, SignalEvent, SignalAction } from "./types.js";

export const STRATEGY_REGISTRY: Record<string, StrategyDefinition> = {
  [emaCross.id]: emaCross,
  [emaCrossTpSl.id]: emaCrossTpSl,
  [emaRsiPctTpSl.id]: emaRsiPctTpSl,
  [customMaCross.id]: customMaCross,
};

export function getStrategy(id: string): StrategyDefinition | undefined {
  return STRATEGY_REGISTRY[id];
}

export function listStrategies(): StrategyDefinition[] {
  return Object.values(STRATEGY_REGISTRY);
}
