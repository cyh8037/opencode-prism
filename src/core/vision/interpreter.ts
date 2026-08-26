import { VISION_INTERPRET_POLL_MS, VISION_SYNC_TIMEOUT_MS } from "../../config/constants"
import type { ResolvedModel } from "../../models"
import { errorInfoFromResult } from "../../shared/api-result"
import { log } from "../../shared/log"
import { lastAssistantText } from "../assistant-text"
import type { PrismClient } from "../client-types"
import type { ImageAttachment } from "./detector"
import { normalizeImageBatch } from "./image-utils"

// Global system prompt for every vision interpretation. Stable structure is
// what makes downstream consumption by the main agent reliable; per-call
// specifics (layout critique, verification, etc.) go in the user instruction.
export const VISION_SYSTEM_PROMPT = [
  "你是 Prism 的视觉分析专家，负责精确、结构化地解读图片内容。",
  "",
  "行为准则:",
  "- 直接给出结论，不要开场白，不要复述任务",
  "- 结构固定为: 一句话概括图片主体 → 分项描述（布局/内容/关键元素/异常）→ 值得注意的细节",
  "- UI 截图重点: 页面结构、可见文字、控件状态、对齐与间距问题、报错或异常元素",
  "- 图表重点: 类型、坐标轴、关键数据点与趋势",
  '- 不确定的内容明确说"不确定"，绝不编造',
  "- 回答语言与图片内容一致（中文界面用中文，英文界面用英文）",
].join("\n")

// Per-call instruction (user message); system-level behavior lives in
// VISION_SYSTEM_PROMPT. A caller-supplied goal focuses the interpretation on
// what is actually needed (higher signal, fewer tokens back into context).
export const VISION_INSTRUCTION = "请解读以下图片。"

export function makeVisionInstruction(goal?: string): string {
  const trimmed = goal?.trim()
  if (!trimmed) return VISION_INSTRUCTION
  return `${VISION_INSTRUCTION}\n重点关注：${trimmed}\n只回答与关注点相关的内容。`
}

// Interpretation children must not run agentic tool loops. The child model
// gets the same global toolset (plugin tools register for every session), and
// a confused child calling vision_look on its own injected image spawns an
// unbounded chain of interpretation grandchildren (2026-08-25 incident: 26+
// children in 60s). Mirrors the background manager's childToolFilters —
// interpretation only needs text back.
const VISION_CHILD_TOOL_FILTERS: Record<string, boolean> = {
  bg_spawn: false,
  bg_cancel: false,
  bg_send: false,
  bg_wait: false,
  split_task: false,
  vision_look: false,
  question: false,
}

// Shared user-facing hint for the manual interpretation surface
// (vision_look tool) when no vision model is available.
export const VISION_NO_MODEL_HINT =
  "视觉解读失败: 无可用视觉模型（vision.model 配置不可用，或未配置且主会话模型不支持图片）。请配置 prism 的 vision.model，或切换到支持图片的主会话模型"

// Why an interpretation failed. Every failure path carries one so the
// user-facing message can state the actual cause instead of the generic
// "no vision model" hint (which wrongly told users with a working
// vision.model that their config was missing).
export type VisionFailureReason =
  | "no-model"
  | "invalid-images"
  | "session-error"
  | "no-output"
  | "timeout"
  | "internal-error"

// Map a failure reason to the message shown by the manual surfaces. The
// optional refs power the invalid-images case: listing what was rejected
// points the user at what to fix.
export function visionFailureMessage(reason: VisionFailureReason, invalidRefs: string[] = []): string {
  switch (reason) {
    case "no-model":
      return VISION_NO_MODEL_HINT
    case "invalid-images": {
      const refs = invalidRefs.filter(Boolean).slice(0, 3)
      const list = refs.length > 0 ? `（已拒绝: ${refs.join("、")}${invalidRefs.length > 3 ? " 等" : ""}）` : ""
      return `视觉解读失败: 图片引用无效或无法读取${list}。请传入图片的本地路径/URL/data URL；解读对话贴图请用 vision_look(["last"])`
    }
    case "session-error":
      return "视觉解读失败: 视觉子会话创建或提交失败（详见插件日志），可稍后重试"
    case "no-output":
      return "视觉解读失败: 视觉模型未返回有效内容，可重试或更换 vision.model"
    case "timeout":
      return "视觉解读失败: 视觉模型响应超时，可重试或更换 vision.model"
    case "internal-error":
      return "视觉解读失败: 插件内部错误（详见插件日志）"
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export interface InterpretationOutcome {
  /** The interpretation text, or null on failure. */
  text: string | null
  /** Failure cause, set iff text is null. Null on success. */
  reason: VisionFailureReason | null
}

// Run a sync vision interpretation: create a child session with the vision
// model, send the images, poll until idle, return the interpretation text.
// Returns text=null on failure (caller degrades gracefully); reason tells
// the retry logic in the pipeline which failures are worth retrying
// (timeout and invalid-images are not).
export async function runVisionInterpretation(args: {
  client: PrismClient
  directory: string
  parentSessionID: string
  images: ImageAttachment[]
  model: ResolvedModel
  instruction?: string
  timeoutMs?: number
  /** Fired with the child session id right after creation — the caller uses
   *  it to guard against the child's own tool output re-triggering an
   *  interpretation (which would recurse unboundedly). */
  onSessionCreated?: (sessionID: string) => void
}): Promise<InterpretationOutcome> {
  const {
    client,
    directory,
    parentSessionID,
    images,
    model,
    instruction = VISION_INSTRUCTION,
    timeoutMs = VISION_SYNC_TIMEOUT_MS,
  } = args

  const normalized = await normalizeImageBatch(images, directory)
  if (normalized.length === 0) {
    log("[prism] vision: no usable images after normalization")
    return { text: null, reason: "invalid-images" }
  }

  // The client resolves 4xx/5xx with { error }; network failures reject, so
  // both shapes are handled here (a rejection must never escape the hook).
  let createResult: { error?: unknown; data?: { id?: string } }
  try {
    createResult = await client.session.create({
      body: {
        parentID: parentSessionID,
        title: "prism vision interpretation",
        model: {
          id: model.modelID,
          providerID: model.providerID,
        },
      },
      query: { directory },
    })
  } catch (error) {
    log("[prism] vision: failed to create child session", { error })
    return { text: null, reason: "session-error" }
  }
  if (createResult.error || !createResult.data?.id) {
    log("[prism] vision: failed to create child session", { error: createResult.error })
    return { text: null, reason: "session-error" }
  }
  const sessionID = createResult.data.id
  args.onSessionCreated?.(sessionID)

  try {
    const parts: Array<Record<string, unknown>> = [
      { type: "text", text: instruction, synthetic: true },
      ...normalized.map((image) => ({
        type: "file",
        mime: image.mime,
        url: image.url,
      })),
    ]

    // The client resolves 4xx/5xx with { error } instead of rejecting, so
    // both the resolved error field and rejections are checked.
    const promptError = await client.session
      .promptAsync({
        path: { id: sessionID },
        body: { system: VISION_SYSTEM_PROMPT, parts, tools: VISION_CHILD_TOOL_FILTERS },
        query: { directory },
      })
      .then((result) => errorInfoFromResult(result)?.message ?? null)
      .catch((error) => (error instanceof Error ? error.message : String(error)))

    if (promptError) {
      log("[prism] vision: promptAsync failed", { sessionID, error: promptError })
      return { text: null, reason: "session-error" }
    }

    const deadline = Date.now() + timeoutMs
    let observedBusy = false
    while (Date.now() < deadline) {
      const messagesResponse = await client.session
        .messages({ path: { id: sessionID }, query: { directory } })
        .catch(() => null)
      const text = messagesResponse ? lastAssistantText(messagesResponse.data) : null
      if (text !== null) return { text, reason: null }

      // The status map only contains non-idle sessions (idle entries are
      // removed when they settle), so an absent entry means idle — but ONLY
      // once the session was observed busy: promptAsync resolves (204) before
      // the session enters the map, so a fresh session looks absent too.
      const statusResponse = await client.session.status().catch(() => null)
      const statusMap = statusResponse?.data as Record<string, { type?: string }> | undefined
      const status = statusMap?.[sessionID]?.type
      if (status === "busy" || status === "retry") {
        observedBusy = true
        await sleep(VISION_INTERPRET_POLL_MS)
        continue
      }
      if (observedBusy && (status === undefined || status === "idle")) {
        // settled without assistant text: model produced nothing usable
        return { text: null, reason: "no-output" }
      }
      await sleep(VISION_INTERPRET_POLL_MS)
    }

    log("[prism] vision: interpretation timed out", { sessionID, timeoutMs })
    return { text: null, reason: "timeout" }
  } finally {
    // Fire-and-forget cleanup: callers may be blocking a hook while this
    // runs, so the abort must not add its own latency. The server tears the
    // session down regardless of whether this promise settles first.
    client.session.abort({ path: { id: sessionID } }).catch(() => {})
  }
}
