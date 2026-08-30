import type { ResolvedModel } from "../../models"
import { errorInfoFromResult } from "../../shared/api-result"
import { log } from "../../shared/log"
import { sleep } from "../../shared/sleep"
import { lastAssistantText } from "../assistant-text"
import type { PrismClient } from "../client-types"

// 一次性 JSON 子会话（规划器 / 意图识别）的公共工具面防线。这些子会话不在
// BackgroundManager 的任务表里，isChildSession 与视觉递归守卫都覆盖不到。
// 过滤器封死的是"子会话主动调用 vision_look / split_task / bg_* / question"
// 的向量；注意残余面：tool-execute-after 的自动解读（Trigger A）守卫同样
// 不识别这类会话，若它们真的调用带图工具（与"只输出 JSON"的指令相悖），
// sync 模式会就地追加解读、async 模式会以该会话为 parent 启动后台任务——
// 由 30s/120s 超时 + abort 兜底，属已知残留而非无界递归。与
// manager.childToolFilters 和 VISION_CHILD_TOOL_FILTERS 互相点名，共同构成
// 子会话工具隔离。
const JSON_CHILD_TOOL_FILTERS: Record<string, boolean> = {
  bg_spawn: false,
  bg_cancel: false,
  bg_send: false,
  bg_wait: false,
  split_task: false,
  vision_look: false,
  question: false,
}

// 在一次性子会话里运行一条期望 JSON 回复的提示，返回最后一条可用的
// assistant 文本；创建/prompt/等待任一失败或超时返回 null（不解析、不重试
// ——重试语义由调用方决定：planner 重试一次，意图识别 fail-open）。
export async function runJsonPromptSession(args: {
  client: PrismClient
  directory: string
  parentSessionID: string
  title: string
  text: string
  model: ResolvedModel
  timeoutMs: number
}): Promise<string | null> {
  const { client, directory, parentSessionID, title, text, model, timeoutMs } = args

  // The client resolves 4xx/5xx with { error }; network failures reject, so
  // both shapes are handled here (a rejection must never escape the hook).
  let createResult: { error?: unknown; data?: { id?: string } }
  try {
    createResult = await client.session.create({
      body: {
        parentID: parentSessionID,
        title,
        model: { id: model.modelID, providerID: model.providerID },
      },
      query: { directory },
    })
  } catch (error) {
    log("[prism] split: failed to create json-prompt session", { title, error })
    return null
  }
  if (createResult.error || !createResult.data?.id) {
    log("[prism] split: failed to create json-prompt session", { title, error: createResult.error })
    return null
  }
  const sessionID = createResult.data.id

  try {
    // The client resolves 4xx/5xx with { error } instead of rejecting, so
    // both the resolved error field and rejections are checked.
    const promptError = await client.session
      .promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text, synthetic: true }], tools: JSON_CHILD_TOOL_FILTERS },
        query: { directory },
      })
      .then((result) => errorInfoFromResult(result)?.message ?? null)
      .catch((error) => (error instanceof Error ? error.message : String(error)))
    if (promptError) {
      log("[prism] split: json-prompt failed", { title, sessionID, error: promptError })
      return null
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const messagesResponse = await client.session
        .messages({ path: { id: sessionID }, query: { directory } })
        .catch(() => null)
      // 4xx/5xx 解析为 { error }（data 为空）:继续轮询只会烧满整个超时预算
      // ——快速失败，重试/fail-open 语义由调用方决定。
      if (messagesResponse?.error) {
        log("[prism] split: json-prompt messages query failed", { title, sessionID, error: messagesResponse.error })
        return null
      }
      const reply = messagesResponse ? lastAssistantText(messagesResponse.data) : null
      if (reply !== null) return reply
      await sleep(500)
    }
    log("[prism] split: json-prompt timed out", { title, sessionID })
    return null
  } finally {
    // 会话创建于 directory 项目下，abort 同参数作用域（与 create/prompt 一致）。
    await client.session.abort({ path: { id: sessionID }, query: { directory } }).catch(() => {})
  }
}
