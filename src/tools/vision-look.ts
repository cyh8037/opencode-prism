import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { VisionPipeline } from "../core/vision/pipeline"
import { guessImageMime, splitPlaceholderRefs, isLastSentinel } from "../core/vision/detector"
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
      '【必调工具】当用户在对话中发送图片/截图、消息中出现 "[Image N]" 占位符、或需要分析本地/网络图片时，必须调用此工具解读。' +
      '注意：若系统提示类似 "Cannot read image.png (this model does not support image input)" 的错误，说明主模型无法直接查看图片，但图片已保存在会话中——仍应调用本工具并传 "last" 读取，不要回复用户"没有收到图片"。' +
      '\n- 对话贴图/截图调用示例: vision_look(images: "last", goal: "提取图中的关键信息")' +
      '\n- 本地文件/URL调用示例: vision_look(images: ["./preview.png"], goal: "检查UI布局")',
    args: {
      images: tool.schema
        .union([
          tool.schema.string().describe('单张图片路径/URL，或 "last" / "[Image N]" 占位符'),
          tool.schema.array(tool.schema.string()).min(1).describe('图片路径列表，或 ["last"]'),
        ])
        .describe('图片来源：对话贴图/截图传 "last" 或 ["last"]；文件/URL 传路径字符串或数组；自动兼容 "[Image N]" 占位符'),
      goal: tool.schema
        .string()
        .optional()
        .describe("想从图片中获取什么信息（必填建议），解读将聚焦于此"),
    },
    async execute(args: { images: string | string[]; goal?: string }, ctx) {
      try {
        // An interpretation child calling vision_look on its own injected
        // image would spawn an unbounded chain of grandchildren — refuse
        // instead of nesting (the onToolOutput guard does not cover this path).
        if (pipeline.isInterpretationSession(ctx.sessionID)) {
          return "视觉解读失败: 解读子会话内不执行嵌套解读（避免递归生成解读子会话）"
        }
        const rawList = Array.isArray(args.images) ? args.images : [args.images]
        // A relay model may serialize the array form as a JSON string
        // ("[\"last\"]") — unwrap it so the sentinel and path handling still
        // see the elements (2026-08-26: deepseek-v4-pro passed exactly this).
        const normalized = rawList
          .flatMap((s) => {
            if (typeof s !== "string") return []
            const trimmed = s.trim()
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
              try {
                const parsed: unknown = JSON.parse(trimmed)
                if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string")
              } catch {
                // Not JSON: the bare "[last]" form (model dropped the quotes)
                // still means the sentinel. Regex excludes "[Image N]"
                // placeholders, which must stay intact for the caller.
                if (/^\[\s*last\s*\]$/i.test(trimmed)) return ["last"]
              }
            }
            return [trimmed]
          })
          .filter((s) => s.length > 0)

        if (normalized.length === 0) {
          return "视觉解读失败: 未提供有效的图片路径或标识"
        }

        const hasLast = normalized.some(isLastSentinel)
        const nonLastRefs = normalized.filter((s) => !isLastSentinel(s))
        const { placeholders, real } = splitPlaceholderRefs(nonLastRefs)

        if (hasLast || (placeholders.length > 0 && real.length === 0)) {
          const result = await pipeline.lookLatest(ctx.sessionID, args.goal)
          if (result.notFound) {
            return "视觉解读失败: 当前会话没有找到任何图片消息。请改用图片的本地路径/URL，或先让用户发送图片"
          }
          const base = result.text ?? visionFailureMessage(result.reason ?? "internal-error")
          // Mixed "last" + explicit refs/placeholders: "last" wins; the
          // dropped refs are noted (mirrors the placeholder-note behavior) so
          // the caller is not left wondering why fewer images were interpreted.
          const ignoredRefs = real.length + placeholders.length
          if (ignoredRefs > 0) {
            const kinds =
              real.length > 0 && placeholders.length > 0
                ? `${real.length} 个显式路径/URL 与 ${placeholders.length} 个占位符`
                : real.length > 0
                  ? `${real.length} 个显式路径/URL`
                  : `${placeholders.length} 个 [Image N] 占位符`
            return `${base}\n\n（已忽略 ${kinds}；"last" 哨兵优先解读会话贴图）`
          }
          return base
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
