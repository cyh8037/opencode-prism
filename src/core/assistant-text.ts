import { z } from "zod"
import { parseSessionMessages } from "../shared/session-data"

// Text part shape. Streaming providers mark finished parts via
// part.state.status === "completed"; parts with no state at all
// (non-streaming providers/gateways) are accepted as-is once non-empty
// instead of making the caller poll until timeout. Incomplete streaming
// parts are still skipped so a poller never grabs a half-generated chunk.
const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  state: z.object({ status: z.string().optional() }).nullish(),
})

function parseTextPart(part: unknown) {
  const parsed = textPartSchema.safeParse(part)
  return parsed.success ? parsed.data : null
}

// Find the latest usable assistant text in a session's message history.
export function lastAssistantText(messages: unknown): string | null {
  const parsed = parseSessionMessages(messages)
  for (let i = parsed.length - 1; i >= 0; i--) {
    const message = parsed[i]
    if (!message || message.info.role !== "assistant") continue
    const parts = message.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parseTextPart(parts[j])
      if (!part || !part.text.trim()) continue
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
  const collected: string[] = []
  let total = 0
  for (const message of parseSessionMessages(messages)) {
    if (message.info.role !== "assistant") continue
    for (const rawPart of message.parts ?? []) {
      const part = parseTextPart(rawPart)
      if (!part || !part.text.trim()) continue
      if (part.state && part.state.status !== "completed") continue
      // The "\n\n" join separator counts against the cap.
      const budget = maxChars - total - (collected.length > 0 ? 2 : 0)
      if (budget <= 0) break
      const slice = part.text.slice(0, budget)
      collected.push(slice)
      total += slice.length + (collected.length > 1 ? 2 : 0)
      if (total >= maxChars) break
    }
  }
  return collected.length > 0 ? collected.join("\n\n") : null
}
