import type { ErrorInfo } from "../models/types"

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
    const err = error as Record<string, unknown>
    const data = err.data as Record<string, unknown> | undefined
    const message =
      typeof data?.message === "string" ? data.message : typeof err.message === "string" ? err.message : undefined
    return {
      name: typeof err.name === "string" ? err.name : undefined,
      message,
      statusCode,
    }
  }
  return { message: typeof error === "string" ? error : String(error), statusCode }
}
