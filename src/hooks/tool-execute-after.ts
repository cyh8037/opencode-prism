import type { PrismConfig } from "../config/schema"
import type { VisionPipeline } from "../core/vision/pipeline"
import { extractImageAttachments } from "../core/vision/detector"

// Trigger A: intercept tool outputs carrying image attachments (screenshot
// tools, image reads). `vision.tools` narrows the check; omitted means all
// tools are inspected, with the attachment detector as the real gate.
export function createToolExecuteAfterHook(args: { config: PrismConfig; pipeline: VisionPipeline }) {
  return async (
    input: { tool: string; sessionID: string; callID?: string },
    output: { title: string; output: string; metadata: unknown },
  ): Promise<void> => {
    const tools = args.config.vision.tools
    if (tools && tools.length > 0 && !tools.includes(input.tool)) return

    const images = extractImageAttachments(output as unknown as Record<string, unknown>)
    if (images.length === 0) return

    await args.pipeline.onToolOutput(input, output, images)
  }
}
