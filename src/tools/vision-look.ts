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
      '[Required Tool] Must be invoked when the user sends images/screenshots in chat, when "[Image N]" placeholders appear in messages, or when analyzing local/remote images.' +
      ' Note: If the system displays an error like "Cannot read image.png (this model does not support image input)", the main model cannot view images directly, but the image is already saved in the session — still invoke this tool with "last" rather than telling the user no image was received.' +
      '\n- Chat image/screenshot example: vision_look(images: "last", goal: "extract key information from the image")' +
      '\n- Local file/URL example: vision_look(images: ["./preview.png"], goal: "check UI layout")',
    args: {
      images: tool.schema
        .union([
          tool.schema.string().describe('Single image path/URL, or "last" / "[Image N]" placeholder'),
          tool.schema.array(tool.schema.string()).min(1).describe('List of image paths, or ["last"]'),
        ])
        .describe('Image source: pass "last" or ["last"] for chat images/screenshots; file path string or array for local/remote URLs; automatically compatible with "[Image N]" placeholders'),
      goal: tool.schema
        .string()
        .optional()
        .describe("What information to extract from the image (strongly recommended); interpretation will focus on this"),
    },
    async execute(args: { images: string | string[]; goal?: string }, ctx) {
      try {
        if (pipeline.isInterpretationSession(ctx.sessionID)) {
          return "Vision interpretation failed: nested interpretation inside child session is disabled (prevents recursive child sessions)"
        }
        const rawList = Array.isArray(args.images) ? args.images : [args.images]
        const normalized = rawList
          .flatMap((s) => {
            if (typeof s !== "string") return []
            const trimmed = s.trim()
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
              try {
                const parsed: unknown = JSON.parse(trimmed)
                if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string")
              } catch {
                if (/^\[\s*last\s*\]$/i.test(trimmed)) return ["last"]
              }
            }
            return [trimmed]
          })
          .filter((s) => s.length > 0)

        if (normalized.length === 0) {
          return "Vision interpretation failed: no valid image path or identifier provided"
        }

        const hasLast = normalized.some(isLastSentinel)
        const nonLastRefs = normalized.filter((s) => !isLastSentinel(s))
        const { placeholders, real } = splitPlaceholderRefs(nonLastRefs)

        if (hasLast || (placeholders.length > 0 && real.length === 0)) {
          const result = await pipeline.lookLatest(ctx.sessionID, args.goal)
          if (result.notFound) {
            return "Vision interpretation failed: no image messages found in the current session. Please provide a local path/URL or send an image first"
          }
          const base = result.text ?? visionFailureMessage(result.reason ?? "internal-error")
          const ignoredRefs = real.length + placeholders.length
          if (ignoredRefs > 0) {
            const kinds =
              real.length > 0 && placeholders.length > 0
                ? `${real.length} explicit paths/URLs and ${placeholders.length} placeholders`
                : real.length > 0
                  ? `${real.length} explicit paths/URLs`
                  : `${placeholders.length} [Image N] placeholders`
            return `${base}\n\n(Ignored ${kinds}; "last" sentinel prioritizes chat images)`
          }
          return base
        }

        const images = real.map((url) => ({ mime: guessImageMime(url), url }))
        const result = await pipeline.look(ctx.sessionID, images, args.goal)
        const base = result.text ?? visionFailureMessage(result.reason ?? "internal-error", real)
        if (placeholders.length > 0) {
          return `${base}\n\n(Ignored ${placeholders.length} [Image N] placeholders; use ["last"] to interpret chat images)`
        }
        return base
      } catch (error) {
        log("[prism] vision_look failed", { error })
        return "Vision interpretation failed: internal plugin error (see plugin logs)"
      }
    },
  })
}
