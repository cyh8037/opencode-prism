import { z } from "zod"
import type { ResolvedModel } from "../models"

// Tolerant zod shapes for OpenCode data boundaries (generated-client returns,
// event hook properties) that arrive as `unknown`. Every schema preserves the
// previous hand-rolled semantics: malformed entries are skipped, never fail
// the whole payload.

// Session message envelope. Only `info.role` and the `parts` list are
// consumed (plus free-form info fields like `model`), so the info object is
// loose and parts stay unknown — the part-level shapes are validated by the
// consumer-specific schemas (text parts, image file parts, tool parts).
const sessionMessageSchema = z.looseObject({
  info: z.looseObject({ role: z.string().optional() }),
  parts: z.array(z.unknown()).nullish(),
})

export type ParsedSessionMessage = z.infer<typeof sessionMessageSchema>

// Parse a session.messages() payload, dropping entries that do not match the
// envelope instead of rejecting the whole array.
export function parseSessionMessages(messages: unknown): ParsedSessionMessage[] {
  if (!Array.isArray(messages)) return []
  const parsed: ParsedSessionMessage[] = []
  for (const item of messages) {
    const result = sessionMessageSchema.safeParse(item)
    if (result.success) parsed.push(result.data)
  }
  return parsed
}

// Event hook properties carrying a session reference: either directly
// (`{ sessionID }`) or nested in the message info (`{ info: { sessionID } }`).
// A non-string direct value falls through to the nested one, matching the
// original typeof-chain behavior.
const eventSessionPropsSchema = z.object({
  sessionID: z.string().optional().catch(undefined),
  info: z.object({ sessionID: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
})

export function eventSessionID(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) return undefined
  const parsed = eventSessionPropsSchema.safeParse(properties)
  if (!parsed.success) return undefined
  return parsed.data.sessionID ?? parsed.data.info?.sessionID
}

// Session/assistant model reference on SDK payloads: `providerID` plus either
// `id` (session object / opencode config shape) or `modelID` (message info
// shape). A non-string `id` rejects the record wholesale — the original
// typeof-chain picked `id` first and failed the whole lookup, so `modelID`
// must not silently rescue it.
const modelRefSchema = z.object({
  providerID: z.string().optional(),
  id: z.string().optional(),
  modelID: z.string().optional(),
})

export function modelFromRecord(value: unknown): ResolvedModel | undefined {
  const parsed = modelRefSchema.safeParse(value)
  if (!parsed.success) return undefined
  const { providerID, id, modelID } = parsed.data
  const resolvedID = id ?? modelID
  if (providerID === undefined || resolvedID === undefined) return undefined
  return { providerID, modelID: resolvedID }
}

// session.status() map: sessionID → { type, message }. Absent entries ARE the
// idle state, so a map that fails validation means "cannot tell busy from
// idle" and every consumer must fail closed (skip/defer, never settle).
export const sessionStatusMapSchema = z.record(
  z.string(),
  z.object({ type: z.string().optional(), message: z.string().optional() }),
)
