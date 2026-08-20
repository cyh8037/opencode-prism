import type { PrismConfig } from "../config/schema"
import type { VisionPipeline } from "../core/vision/pipeline"
import type { CurrentModelTracker } from "../core/vision/model-tracker"
import { extractImageParts } from "../core/vision/detector"

// Trigger B: user attached images directly in a chat message. Also feeds the
// model tracker with the session model.
//
// The hook receives (input, output): the user message and its parts arrive in
// the SECOND argument ({ message, parts }) — input carries only sessionID/
// agent/model/messageID/variant, so reading input.parts would always be
// undefined.
export function createChatMessageHook(args: {
  config: PrismConfig
  pipeline: VisionPipeline
  tracker: CurrentModelTracker
}) {
  return async (
    input: {
      sessionID: string
      messageID?: string
      model?: { providerID?: string; modelID?: string }
    },
    output: { message?: unknown; parts?: unknown },
  ): Promise<void> => {
    args.tracker.onChatMessage(input)
    if (!args.config.vision.chatImages) return
    const images = extractImageParts(output.parts)
    if (images.length === 0) return
    // messageID ties the background interpretation to the message that the
    // messages.transform hook will find in the outgoing LLM context.
    //
    // input.messageID is OPTIONAL — when the client does not generate one,
    // opencode commits the message under a freshly generated id and the hook
    // input never learns it. output.message is the info object opencode
    // commits, whose id is always final and identical to the id the
    // messages.transform hook sees on the message in the LLM context.
    const messageID = (output.message as { id?: string } | undefined)?.id ?? input.messageID
    await args.pipeline.onChatImages(input.sessionID, images, messageID)
  }
}
