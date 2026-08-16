import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { VisionPipeline } from "../core/vision/pipeline"

function guessMime(url: string): string {
  const match = url.match(/^data:(image\/[a-z+]+);base64,/)
  if (match) return match[1]!
  const extension = url.split("?")[0]?.split(".").pop()?.toLowerCase()
  switch (extension) {
    case "jpeg":
    case "jpg":
      return "image/jpeg"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    default:
      return "image/png"
  }
}

// Manual vision interpretation (the automatic triggers cover screenshots and
// chat images; this tool covers explicit URLs and data URLs).
export function createVisionLookTool(pipeline: VisionPipeline): ToolDefinition {
  return tool({
    description:
      "用视觉模型解读图片（URL 或 data URL）。返回详细的视觉描述。自动视觉解读会处理截图工具输出和对话图片，本工具用于显式指定的图片。",
    args: {
      images: tool.schema.array(tool.schema.string()).describe("图片 URL 或 data URL 列表"),
    },
    async execute(args: { images: string[] }, ctx) {
      const images = args.images.map((url) => ({ mime: guessMime(url), url }))
      const text = await pipeline.look(ctx.sessionID, images)
      if (text === null) {
        return "视觉解读失败: 视觉模型链不可用或全部重试耗尽，请检查 prism 配置的 vision.fallbackChain"
      }
      return text
    },
  })
}
