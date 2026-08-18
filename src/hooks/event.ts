import type { BackgroundManager } from "../core/background/manager"
import type { CurrentModelTracker } from "../core/vision/model-tracker"

const FORWARDED_EVENT_TYPES = new Set([
  "message.part.updated",
  "session.idle",
  "session.error",
  "session.deleted",
  "session.status",
])

function eventSessionID(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) return undefined
  const direct = properties.sessionID
  if (typeof direct === "string") return direct
  const info = properties.info
  if (typeof info === "object" && info !== null) {
    const infoSessionID = (info as Record<string, unknown>).sessionID
    if (typeof infoSessionID === "string") return infoSessionID
  }
  return undefined
}

// Forward the subset of OpenCode events the background engine consumes; drop
// the model tracker's per-session snapshot when a session goes away.
export function createEventHook(manager: BackgroundManager, tracker: CurrentModelTracker) {
  return async (input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void> => {
    if (input.event.type === "session.deleted") {
      const sessionID = eventSessionID(input.event.properties)
      if (sessionID) tracker.clear(sessionID)
    }
    if (!FORWARDED_EVENT_TYPES.has(input.event.type)) return
    manager.handleEvent(input.event)
  }
}
