import type { PrismConfig } from "../config/schema"
import type { BackgroundManager } from "../core/background/manager"
import type { VisionPipeline } from "../core/vision/pipeline"
import { extractImageParts } from "../core/vision/detector"
import { makePartID } from "../core/vision/part-id"
import type { CurrentModelTracker } from "../core/vision/model-tracker"

// Hint path for pasted images: a text-only main model sees pasted images
// replaced by a "Cannot read ... (this model does not support image input)"
// error at request time and concludes the image never arrived — it then
// answers "图片没传过来" instead of calling vision_look (2026-08-25/26
// incidents: repeated failures even with a strongly worded tool description;
// the tool description lives in the system area where attention dilutes).
// Injecting a reminder at the END of the user message (id sorts after the
// original parts, see makePartID) puts the instruction where the model reads
// it first. Zero blocking: no interpretation happens here — the model
// performs the vision_look call itself.
export function createChatMessageHook(args: {
  config: PrismConfig
  pipeline: VisionPipeline
  background: BackgroundManager
  tracker: CurrentModelTracker
}) {
  return async (
    input: { sessionID: string },
    output: { message?: { id?: string }; parts: Array<Record<string, unknown>> },
  ): Promise<void> => {
    // Same gate as the other triggers; a disabled feature stays closed here.
    if (!args.config.vision.enabled) return
    // "auto" is reserved (auto-interpretation, not implemented) — it behaves
    // as "hint" until the feature lands.
    if (args.config.vision.chatImages === false) return
    // Children receive injected prompts that may carry images; a reminder
    // there would re-arm the accident-1 recursion chain (a child instructed
    // to vision_look its own injected image). Covers BOTH bg task children
    // (in the background manager) and sync interpretation children (created
    // directly by runVisionInterpretation, tracked by the pipeline).
    if (args.background.isChildSession(input.sessionID)) return
    if (args.pipeline.isInterpretationSession(input.sessionID)) return
    // A vision-capable session sees the image natively — no reminder needed.
    if (args.tracker.get(input.sessionID)?.visionCapable) return

    const images = extractImageParts(output.parts)
    if (images.length === 0) return

    // 命令回合检测:/bg、/split 的用户消息携带 opencode 注入的命令模板
    // (template 是 user 消息的一部分)。命令带图时,默认的 vision_look
    // 提醒会把模型带偏——实测(2026-08-28 会话 ses_fb868779)无视觉模型
    // 收到图片报错后,在"消息尾部提醒"的引导下直接 vision_look 同步解读,
    // 放弃用户显式要求的 bg_spawn 后台化。命令回合必须注入命令专用提醒。
    const parts = output.parts
    const isBgCommandTurn = parts.some(
      (part) => typeof part.text === "string" && part.text.includes("你在处理 Prism 的 /bg 命令"),
    )
    const isSplitCommandTurn = parts.some(
      (part) => typeof part.text === "string" && part.text.includes("你在处理 Prism 的 /split 命令"),
    )

    // 1.18.23 contract: parts pushed here MUST carry id (prt_ prefix) /
    // sessionID / messageID or the message save dies ("invalid user part
    // before save" + prompt_async InvalidDurableEvent — the 2026-08-25
    // session freeze). messageID comes from output.message.id — the TUI does
    // not send one, and opencode assigns it before this hook fires.
    output.parts.push({
      id: makePartID(),
      sessionID: input.sessionID,
      messageID: output.message?.id,
      type: "text",
      // Conditional wording: on the FIRST message of a session the tracker
      // snapshot is still empty (chat.params has not fired yet), so we
      // cannot know whether the main model sees images — the reminder must
      // not assert it does not.
      text: isBgCommandTurn
        ? '[prism bg] 这是 /bg 后台任务命令：请调用 bg_spawn 工具（description/prompt），插件会自动把当前消息中的图片传给后台子会话，' +
          '子会话用 vision_look 工具读图。不要用 vision_look 同步解读——用户显式要求后台执行。'
        : isSplitCommandTurn
          ? '[prism split] 这是 /split 拆分命令：请调用 split_task 工具。图片不会自动传给子任务，' +
            '必须把图片的本地路径/URL 写进 task 描述，子任务用 vision_look 工具读图。' +
            '不要用 vision_look 同步解读——用户显式要求拆分执行。'
          : '[prism vision] 如果你的模型无法直接查看图片（例如出现 "Cannot read image.png" 错误），说明图片已保存在本会话中——' +
            '请调用 vision_look 工具（images: "last"）读取图片内容后再回答。' +
            '不要回复用户"图片未收到"或"无法读取图片"。',
      synthetic: true,
    })
  }
}
