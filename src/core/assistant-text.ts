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

// Concatenate EVERY completed assistant text in message order, capped at
// maxChars. Used for background-task results: a multi-turn child session's
// intermediate conclusions matter as much as its final line, and "last text
// only" silently dropped them.
export function collectAssistantText(messages: unknown, maxChars: number): string | null {
  if (!Array.isArray(messages)) return null
  const collected: string[] = []
  let total = 0
  for (const message of messages) {
    const record = message as { info?: { role?: string }; parts?: unknown[] }
    if (record.info?.role !== "assistant") continue
    for (const part of record.parts ?? []) {
      const p = part as { type?: string; text?: string; state?: { status?: string } } | undefined
      if (p?.type !== "text" || !p.text?.trim()) continue
      if (p.state && p.state.status !== "completed") continue
      // The "\n\n" join separator counts against the cap.
      const budget = maxChars - total - (collected.length > 0 ? 2 : 0)
      if (budget <= 0) break
      const slice = p.text.slice(0, budget)
      collected.push(slice)
      total += slice.length + (collected.length > 1 ? 2 : 0)
      if (total >= maxChars) break
    }
  }
  return collected.length > 0 ? collected.join("\n\n") : null
}
