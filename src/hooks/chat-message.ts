import type { PrismConfig } from "../config/schema"
import type { VisionPipeline } from "../core/vision/pipeline"
import { extractImageParts } from "../core/vision/detector"

// Trigger B: user attached images directly in a chat message.
export function createChatMessageHook(args: { config: PrismConfig; pipeline: VisionPipeline }) {
  return async (input: { sessionID: string; parts: unknown }): Promise<void> => {
    if (!args.config.vision.chatImages) return
    const images = extractImageParts(input.parts)
    if (images.length === 0) return
    await args.pipeline.onChatImages(input.sessionID, images)
  }
}
