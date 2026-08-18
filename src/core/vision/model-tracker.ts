import type { ResolvedModel } from "../../models"

// Per-session snapshot of the parent session's current model, fed by the
// chat.params hook (fires before every LLM call with the resolved Model).
// capabilities.input.image is the same signal opencode's runtime uses to
// decide whether a model accepts image parts, so a gate built on this can
// never diverge from runtime behavior — and it refreshes every turn, so model
// switches are followed automatically with no caching or invalidation.
export interface SessionModelSnapshot {
  model: ResolvedModel
  visionCapable: boolean
  /** True when the capability came from chat.params; chat.message has no
   *  capability info, so a message-only snapshot means "unknown yet". */
  capabilityKnown: boolean
}

export class CurrentModelTracker {
  private bySession = new Map<string, SessionModelSnapshot>()

  // chat.params: the resolved Model about to be used for the next LLM call.
  onChatParams(input: {
    sessionID: string
    model?: { providerID?: string; id?: string; capabilities?: { input?: { image?: boolean } } }
  }): void {
    const model = input.model
    if (!model?.providerID || !model.id) return
    this.bySession.set(input.sessionID, {
      model: {
        providerID: model.providerID,
        modelID: model.id,
      },
      // Missing capability info is treated as non-vision (conservative skip).
      visionCapable: model.capabilities?.input?.image === true,
      capabilityKnown: true,
    })
  }

  // chat.message: user messages carry the session model.
  onChatMessage(input: { sessionID: string; model?: { providerID?: string; modelID?: string } }): void {
    const model = input.model
    if (!model?.providerID || !model.modelID) return
    const existing = this.bySession.get(input.sessionID)
    this.bySession.set(input.sessionID, {
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
      // chat.message has no capability info; keep the last known capability,
      // or assume non-vision until a chat.params confirms otherwise.
      visionCapable: existing?.visionCapable ?? false,
      capabilityKnown: existing?.capabilityKnown ?? false,
    })
  }

  get(sessionID: string): SessionModelSnapshot | undefined {
    return this.bySession.get(sessionID)
  }

  clear(sessionID: string): void {
    this.bySession.delete(sessionID)
  }
}
