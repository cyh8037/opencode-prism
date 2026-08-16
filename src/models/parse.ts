import { VARIANT_VALUES } from "../config/constants"
import type { ResolvedModel, Variant } from "./types"

function isVariant(value: string): value is Variant {
  return (VARIANT_VALUES as readonly string[]).includes(value)
}

// Parse an explicit model reference: "provider/model" with an optional
// variant suffix: "anthropic/claude-fable-5 xhigh". Returns null when the
// reference is malformed. Slashes inside the model id are allowed (only the
// first segment is the provider).
export function parseModelRef(reference: string): ResolvedModel | null {
  const tokens = reference.trim().split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) return null

  let variant: Variant | undefined
  const last = tokens[tokens.length - 1]!
  if (tokens.length >= 2 && isVariant(last)) {
    variant = last
    tokens.pop()
  }
  if (tokens.length !== 1) return null

  const core = tokens[0]!
  const slashIndex = core.indexOf("/")
  if (slashIndex <= 0) return null

  const providerID = core.slice(0, slashIndex)
  const modelID = core.slice(slashIndex + 1)
  if (providerID.length === 0 || modelID.length === 0) return null

  return {
    providerID,
    modelID,
    ...(variant ? { variant } : {}),
  }
}
