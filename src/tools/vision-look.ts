import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { VisionPipeline } from "../core/vision/pipeline"
import { guessImageMime, splitPlaceholderRefs } from "../core/vision/detector"
import { visionFailureMessage } from "../core/vision/interpreter"
import { log } from "../shared/log"

// Manual vision interpretation. The automatic trigger covers tool outputs
// with image attachments; this tool covers explicit images (URLs, paths) and
// — via the "last" sentinel — the most recent image of the conversation,
// which is how a text-only main model can read a pasted chat image it has no
// URL reference for.
export function createVisionLookTool(pipeline: VisionPipeline): ToolDefinition {
  return tool({
    description:
      '用视觉模型解读图片，返回与 goal 相关的描述。images 支持 URL、data URL、本地文件路径（相对路径按项目目录解析），以及哨兵值 "last"（单独使用时表示"本会话最近的一张图片"——用户在对话里贴图/截图而你无法直接查看图片内容时，用它解读）。"[Image N]" 附件占位符会被当作 "last" 处理。goal 建议始终提供：说明你要从图片里得到什么（如"找出报错信息""对比与设计稿的布局差异"），解读会只回答关注点相关内容。',
    args: {
      images: tool.schema.array(tool.schema.string()).min(1).describe('图片 URL、data URL、本地路径列表；或 ["last"] 表示会话内最近的图片'),
      goal: tool.schema.string().optional().describe("想从图片中获取什么信息（必答项），解读只返回与 goal 相关的内容"),
    },
    async execute(args: { images: string[]; goal?: string }, ctx) {
      try {
        if (args.images.length === 1 && args.images[0] === "last") {
          const result = await pipeline.lookLatest(ctx.sessionID, args.goal)
          if (result.notFound) {
            return "视觉解读失败: 当前会话没有找到任何图片消息。请改用图片的本地路径/URL，或先让用户发送图片"
          }
          return result.text ?? visionFailureMessage(result.reason ?? "internal-error")
        }
        // A relay model may forward "[Image N]" attachment placeholders as
        // if they were references; they carry no path or URL, so with only
        // placeholders the target is the session's latest image message.
        const { placeholders, real } = splitPlaceholderRefs(args.images)
        if (placeholders.length > 0 && real.length === 0) {
          const result = await pipeline.lookLatest(ctx.sessionID, args.goal)
          if (result.notFound) {
            return "视觉解读失败: 未能定位图片（会话中没有图片消息）。请改用图片的本地路径/URL，或先让用户发送图片"
          }
          return result.text ?? visionFailureMessage(result.reason ?? "internal-error")
        }
        const images = real.map((url) => ({ mime: guessImageMime(url), url }))
        const result = await pipeline.look(ctx.sessionID, images, args.goal)
        const base = result.text ?? visionFailureMessage(result.reason ?? "internal-error", real)
        if (placeholders.length > 0) {
          return `${base}\n\n（已忽略 ${placeholders.length} 个 [Image N] 占位符；解读对话贴图请用 ["last"]）`
        }
        return base
      } catch (error) {
        log("[prism] vision_look failed", { error })
        return "视觉解读失败: 插件内部错误（详见插件日志）"
      }
    },
  })
}
