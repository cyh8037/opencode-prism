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
    // Same gate exists in getVisionModel (index.ts) and pipeline.onToolOutput —
    // the triple redundancy is deliberate, and each site's comment names the
    // others so no single "simplification" silently reopens the feature.
    if (!args.config.vision.enabled) return
    // undefined = inspect every tool's output; an explicit array (including
    // an empty one) = only the listed tools trigger interpretation.
    const tools = args.config.vision.tools
    if (Array.isArray(tools) && !tools.includes(input.tool)) return

    const images = extractImageAttachments(output as unknown as Record<string, unknown>)
    if (images.length === 0) return

    await args.pipeline.onToolOutput(input, output, images)
  }
}
