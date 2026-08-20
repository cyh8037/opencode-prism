import type { ResolvedModel } from "../../models"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

// Resolve the model a vision interpretation should use for a session, waiting
// up to timeoutMs for the first capability snapshot when no explicit model is
// configured. Mirrors the config-first order of the sync getVisionModel: an
// explicit vision.model wins immediately (the session snapshot is irrelevant
// to it), an invalid reference stays permanently off, and the snapshot gate
// only applies to the inherit-session-model fallback. chat.message (trigger B)
// fires BEFORE the session's first chat.params, so a fresh session has no
// known capability when an image arrives — the wait is short and bounded
// because the LLM call for the just-submitted message is imminent.
export async function waitForVisionModel(args: {
  visionModel?: ResolvedModel
  visionRefInvalid: boolean
  tracker: CurrentModelTracker
  sessionID: string
  timeoutMs: number
}): Promise<ResolvedModel | undefined> {
  const { visionModel, visionRefInvalid, tracker, sessionID, timeoutMs } = args
  if (visionModel) return visionModel
  if (visionRefInvalid) return undefined
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = tracker.get(sessionID)
    if (snapshot?.capabilityKnown) {
      return snapshot.visionCapable ? snapshot.model : undefined
    }
    await sleep(50)
  }
  const snapshot = tracker.get(sessionID)
  return snapshot?.visionCapable ? snapshot.model : undefined
}
