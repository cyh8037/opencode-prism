import type { BackgroundManager } from "../core/background/manager"

const FORWARDED_EVENT_TYPES = new Set([
  "message.part.updated",
  "session.idle",
  "session.error",
  "session.deleted",
  "session.status",
])

// Forward the subset of OpenCode events the background engine consumes.
export function createEventHook(manager: BackgroundManager) {
  return async (input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void> => {
    if (!FORWARDED_EVENT_TYPES.has(input.event.type)) return
    manager.handleEvent(input.event)
  }
}
