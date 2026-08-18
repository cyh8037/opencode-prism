// Find the latest usable assistant text in a session's message history.
// Streaming providers mark finished parts via part.state.status ===
// "completed"; parts with no state at all (non-streaming providers/gateways)
// are accepted as-is once non-empty instead of making the caller poll until
// timeout. Incomplete streaming parts are still skipped so a poller never
// grabs a half-generated chunk.
export function lastAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { info?: { role?: string }; parts?: unknown[] }
    if (message.info?.role !== "assistant") continue
    const parts = message.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as { type?: string; text?: string; state?: { status?: string } } | undefined
      if (part?.type !== "text" || !part.text?.trim()) continue
      if (!part.state || part.state.status === "completed") return part.text
    }
  }
  return null
}
