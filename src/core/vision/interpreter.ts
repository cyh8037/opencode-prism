import { VISION_SYNC_TIMEOUT_MS } from "../../config/constants"
import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
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
// VISION_SYSTEM_PROMPT. Keep this specific to what THIS call needs.
export const VISION_INSTRUCTION = "请解读以下图片。".trim()

interface SessionMessage {
  info?: { role?: string }
  parts?: Array<{ type?: string; text?: string; state?: { status?: string } }>
}

function lastAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as SessionMessage
    if (message.info?.role !== "assistant") continue
    const parts = message.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part?.type === "text" && part.state?.status === "completed" && part.text?.trim()) {
        return part.text
      }
    }
  }
  return null
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Run a sync vision interpretation: create a child session with the vision
// model, send the images, poll until idle, return the interpretation text.
// Returns null on timeout or chain-level failure (caller degrades gracefully).
export async function runVisionInterpretation(args: {
  client: PrismClient
  directory: string
  parentSessionID: string
  images: ImageAttachment[]
  model: ResolvedModel
  instruction?: string
  timeoutMs?: number
}): Promise<string | null> {
  const {
    client,
    directory,
    parentSessionID,
    images,
    model,
    instruction = VISION_INSTRUCTION,
    timeoutMs = VISION_SYNC_TIMEOUT_MS,
  } = args

  const normalized = await normalizeImageBatch(images)
  if (normalized.length === 0) {
    log("[prism] vision: no usable images after normalization")
    return null
  }

  const createResult = await client.session.create({
    body: {
      parentID: parentSessionID,
      title: "prism vision interpretation",
      model: {
        id: model.modelID,
        providerID: model.providerID,
        ...(model.variant ? { variant: model.variant } : {}),
      },
    },
    query: { directory },
  })
  if (createResult.error || !createResult.data?.id) {
    log("[prism] vision: failed to create child session", { error: createResult.error })
    return null
  }
  const sessionID = createResult.data.id

  try {
    const parts: Array<Record<string, unknown>> = [
      { type: "text", text: instruction, synthetic: true },
      ...normalized.map((image) => ({
        type: "file",
        mime: image.mime,
        url: image.url,
      })),
    ]

    const promptError = await client.session
      .promptAsync({
        path: { id: sessionID },
        body: { system: VISION_SYSTEM_PROMPT, parts },
        query: { directory },
      })
      .then(() => null)
      .catch((error) => error)

    if (promptError) {
      log("[prism] vision: promptAsync failed", { sessionID, error: promptError })
      return null
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const messagesResponse = await client.session
        .messages({ path: { id: sessionID }, query: { directory } })
        .catch(() => null)
      const text = messagesResponse ? lastAssistantText(messagesResponse.data) : null
      if (text !== null) return text

      const statusResponse = await client.session
        .get({ path: { id: sessionID } })
        .catch(() => null)
      const status = statusResponse?.data?.status
      if (status === "idle") {
        // idle without assistant text: model produced nothing usable
        return null
      }
      await sleep(500)
    }

    log("[prism] vision: interpretation timed out", { sessionID, timeoutMs })
    return null
  } finally {
    await client.session.abort({ path: { id: sessionID } }).catch(() => {})
  }
}
