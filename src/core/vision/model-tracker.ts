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
    })
  }

  get(sessionID: string): SessionModelSnapshot | undefined {
    return this.bySession.get(sessionID)
  }

  clear(sessionID: string): void {
    this.bySession.delete(sessionID)
  }
}
