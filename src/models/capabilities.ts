import type { ModelCapabilities } from "./types"

// Bundled vision-capability snapshot. Only one field matters: whether the
// model accepts image input. Keys are canonical model ids, compared after
// normalization (lowercase, dots -> dashes).
//
// Snapshot drift: refresh via `prism refresh-models` (CLI lands after M1).
// Unknown models return null (treated as "allow with warning" by resolution).
const VISION_CAPABLE: Record<string, boolean> = {
  "claude-fable-5": true,
  "claude-opus-5": true,
  "claude-sonnet-5": true,
  "claude-haiku-4-5": true,
  "gpt-5-6-sol": true,
  "gpt-5-6-luna-fast": true,
  "kimi-k3": true,
  "glm-5-2": true,
  "deepseek-v4-flash": false,
  "deepseek-v4-pro": false,
}

export function canonicalizeModelID(modelID: string): string {
  return modelID.toLowerCase().replace(/\./g, "-")
}

export class StaticModelCapabilities implements ModelCapabilities {
  constructor(private table: Record<string, boolean> = VISION_CAPABLE) {}

  isVisionCapable(model: string): boolean | null {
    const key = canonicalizeModelID(model)
    const value = this.table[key]
    if (value === undefined) return null
    return value
  }
}
