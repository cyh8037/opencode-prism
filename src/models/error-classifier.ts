import type { ErrorInfo } from "./types"

const RETRYABLE_PATTERNS = [
  /rate\s*limit/i,
  /too many requests/i,
  // 状态码词匹配必须带 \b 锚定：裸 /500/ 会命中 "1500 tokens" 这类正文，
  // 把非限流错误误判为可重试。
  /\b429\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /overloaded/i,
  /service unavailable/i,
  /timeout/i,
  /timed out/i,
  /temporarily unavailable/i,
  /throttl/i,
  /capacity/i,
  /connection (?:was )?reset/i,
  /network error/i,
  /upstream/i,
]

export function shouldRetryError(error: ErrorInfo): boolean {
  const message = error.message ?? ""
  const name = error.name ?? ""
  if (error.statusCode !== undefined) {
    if (error.statusCode === 429) return true
    if (error.statusCode >= 500) return true
  }
  if (name !== "" && RETRYABLE_PATTERNS.some((pattern) => pattern.test(name))) return true
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))
}

export function isAgentNotFoundError(error: ErrorInfo): boolean {
  const message = error.message ?? ""
  return /agent.*not found|agent\.name|unknown agent/i.test(message)
}
