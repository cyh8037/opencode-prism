import type { BackgroundManager } from "../core/background/manager"
import type { PromptGate } from "../core/prompt-gate"
import type { CurrentModelTracker } from "../core/vision/model-tracker"
import { eventSessionID } from "../shared/session-data"

const FORWARDED_EVENT_TYPES = new Set([
  "message.part.updated",
  "session.idle",
  "session.error",
  "session.deleted",
  "session.status",
])

// Forward the subset of OpenCode events the background engine consumes; drop
// the model tracker's per-session snapshot and the gate's per-session state
// (dispatch chain, reservation, dedupe window) when a session goes away.
export function createEventHook(manager: BackgroundManager, tracker: CurrentModelTracker, gate: PromptGate) {
  return async (input: { event: { type: string; properties?: Record<string, unknown> } }): Promise<void> => {
    if (input.event.type === "session.deleted") {
      const sessionID = eventSessionID(input.event.properties)
      if (sessionID) {
        tracker.clear(sessionID)
        gate.clear(sessionID)
        // The parent session is gone: retire its tasks so children are not
        // left running against a dead owner (their completion wakes would
        // dispatch to a deleted session and be lost).
        void manager.cancelAllByParentSession(sessionID, "parent session deleted")
      }
    }
    if (!FORWARDED_EVENT_TYPES.has(input.event.type)) return
    manager.handleEvent(input.event)
  }
}
