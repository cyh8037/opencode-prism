import { z } from "zod"
import type { ErrorInfo } from "../models/types"

// Tolerant error-like shape: every field degrades to undefined instead of
// failing the whole parse, and the SDK body's `data.message` wins over the
// envelope's own `message`.
const errorLikeSchema = z.object({
  name: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  statusCode: z.number().optional().catch(undefined),
  data: z.object({ message: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
})

// Extract an ErrorInfo from an error-shaped object (SDK 4xx/5xx payloads,
// thrown non-Error objects). Never throws; unreadable fields stay undefined.
export function errorInfoFromObject(error: object): ErrorInfo {
  const parsed = errorLikeSchema.safeParse(error)
  if (!parsed.success) return {}
  const { name, message, statusCode, data } = parsed.data
  return { name, message: data?.message ?? message, statusCode }
}

// The generated SDK client resolves 4xx/5xx with `{ error, response }`
// instead of rejecting (throwOnError defaults to false); only network
// failures reject. Normalize both shapes into the ErrorInfo the retry
// classifier expects, or undefined when the call succeeded.
export function errorInfoFromResult(result: unknown): ErrorInfo | undefined {
  if (typeof result !== "object" || result === null) return undefined
  const record = result as { error?: unknown; response?: { status?: number } }
  const error = record.error
  if (error === undefined || error === null) return undefined

  const statusCode = record.response?.status
  if (error instanceof Error) {
    return { name: error.name, message: error.message, statusCode }
  }
  if (typeof error === "object") {
    return { ...errorInfoFromObject(error), statusCode }
  }
  return { message: typeof error === "string" ? error : String(error), statusCode }
}
