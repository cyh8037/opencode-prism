import type { ResolvedModel } from "./types"

// Parse an explicit model reference: "provider/model". Slashes inside the
// model id are allowed (only the first segment is the provider); whitespace
// is rejected — a variant suffix like "provider/model max" is not supported.
export function parseModelRef(reference: string): ResolvedModel | null {
  const core = reference.trim()
  if (core.length === 0 || /\s/.test(core)) return null
  const slashIndex = core.indexOf("/")
  if (slashIndex <= 0) return null

  const providerID = core.slice(0, slashIndex)
  const modelID = core.slice(slashIndex + 1)
  if (providerID.length === 0 || modelID.length === 0) return null

  return { providerID, modelID }
}
