import type { CurrentModelTracker } from "../core/vision/model-tracker"

// Feed the model tracker: chat.params fires before every LLM call with the
// resolved Model (including capabilities), which is the freshest source of
// "what model is this session on right now and can it see images". Read-only.
export function createChatParamsHook(tracker: CurrentModelTracker) {
  return async (input: {
    sessionID: string
    model?: { providerID?: string; id?: string; capabilities?: { input?: { image?: boolean } } }
  }): Promise<void> => {
    tracker.onChatParams(input)
  }
}
