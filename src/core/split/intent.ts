import { INTENT_CHECK_TIMEOUT_MS, MAX_INTENT_REASON_CHARS } from "../../config/constants"
import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
import type { PrismClient } from "../client-types"
import { sanitizeTruncate } from "../background/visualizer"
import { runJsonPromptSession } from "./json-prompt"
import { z } from "zod"

// 中性提示词：意图识别是"判断是否值得拆"，不是"执行拆分"。沿用规划器的
// 拆分导向措辞会让分类器偏向 split，判定就失去了意义。
export const INTENT_PROMPT = (task: string): string =>
  [
    "你是任务分析器。判断下面的任务是否适合拆分为多个可独立执行的子任务"
      + "（可并行、各自有明确完成标准、由独立 agent 完成），还是应该作为单个任务直接执行。",
    "",
    "只输出 JSON，不要任何其他文字或 markdown 代码块：",
    '{"intent":"split","reason":"..."} 或 {"intent":"direct","reason":"..."}',
    "",
    `任务: ${task}`,
  ].join("\n")

export const intentSchema = z.object({
  intent: z.enum(["split", "direct"]),
  reason: z.string().optional(),
})

export type SplitIntent = z.infer<typeof intentSchema>

// Extract the first JSON object from a model reply that may wrap it in fences
// or stray prose. Symmetric with the planner's extractJsonArray (arrays and
// objects need different bracket scans).
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1]! : text

  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

// reason 是子会话 LLM 输出（不可信文本），直接拼进返回消息并注入主会话——
// 控制字符/ANSI 剥离 + 截断后才能出门。
export function sanitizeIntentReason(reason: string | undefined): string {
  return sanitizeTruncate(reason ?? "", MAX_INTENT_REASON_CHARS)
}

// 拆分前的意图判定。fail-open 是硬性语义：分类子会话的任何失败（创建/
// prompt/超时/解析）都视为可拆分并继续原流程——intentCheck 是成本优化器
// 不是安全闸，绝不能因为识别挂掉而让 /split 不可用；重试只是把等待加倍，
// 因此不做。
export async function checkSplitIntent(args: {
  client: PrismClient
  directory: string
  parentSessionID: string
  task: string
  model: ResolvedModel
}): Promise<SplitIntent> {
  const text = await runJsonPromptSession({
    client: args.client,
    directory: args.directory,
    parentSessionID: args.parentSessionID,
    title: "prism split intent",
    text: INTENT_PROMPT(args.task),
    model: args.model,
    timeoutMs: INTENT_CHECK_TIMEOUT_MS,
  }).catch((error) => {
    log("[prism] split: intent check threw; failing open", { error })
    return null
  })
  if (!text) return { intent: "split" }

  const parsed = intentSchema.safeParse(extractJsonObject(text))
  if (!parsed.success) {
    log("[prism] split: intent output failed schema validation", {
      issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
    })
    return { intent: "split" }
  }
  log("[prism] split: intent verdict", { intent: parsed.data.intent, reason: parsed.data.reason })
  return parsed.data
}
