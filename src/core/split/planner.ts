import { MAX_SUBTASKS, PLANNER_SYNC_TIMEOUT_MS } from "../../config/constants"
import type { ResolvedModel } from "../../models"
import { errorInfoFromResult } from "../../shared/api-result"
import { log } from "../../shared/log"
import { lastAssistantText } from "../assistant-text"
import type { PrismClient } from "../client-types"
import { subTaskPlanArraySchema, type SubTaskPlan } from "./plan-schema"

export const PLANNER_PROMPT = (task: string, maxSubtasks: number): string => [
  "你是任务拆分规划器。把下面的复杂任务拆成可独立执行的子任务。",
  "",
  "要求:",
  `- 2 到 ${maxSubtasks} 个子任务，每个子任务有明确的完成标准`,
  "- 每个子任务必须能由单个 agent 独立完成（可并行时不互相依赖）",
  "- 有依赖时用 dependsOn 引用其他子任务的 id（被引用者必须先完成）",
  "- 只输出 JSON 数组，不要任何其他文字或 markdown 代码块",
  "",
  "JSON 格式:",
  `[{"id":"s1","title":"...","description":"...","dependsOn":[]}]`,
  "",
  `任务: ${task}`,
].join("\n")

// Extract the first JSON array from a model reply that may wrap it in fences
// or stray prose.
function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1]! : text

  const start = candidate.indexOf("[")
  const end = candidate.lastIndexOf("]")
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function runPlannerOnce(args: {
  client: PrismClient
  directory: string
  parentSessionID: string
  task: string
  model: ResolvedModel
  timeoutMs: number
  maxSubtasks: number
}): Promise<SubTaskPlan[] | null> {
  const { client, directory, parentSessionID, task, model, timeoutMs, maxSubtasks } = args

  // The client resolves 4xx/5xx with { error }; network failures reject, so
  // both shapes are handled here (a rejection must never escape the hook).
  let createResult: { error?: unknown; data?: { id?: string } }
  try {
    createResult = await client.session.create({
      body: {
        parentID: parentSessionID,
        title: "prism split planner",
        model: { id: model.modelID, providerID: model.providerID },
      },
      query: { directory },
    })
  } catch (error) {
    log("[prism] split: failed to create planner session", { error })
    return null
  }
  if (createResult.error || !createResult.data?.id) {
    log("[prism] split: failed to create planner session", { error: createResult.error })
    return null
  }
  const sessionID = createResult.data.id

  try {
    // The client resolves 4xx/5xx with { error } instead of rejecting, so
    // both the resolved error field and rejections are checked.
    const promptError = await client.session
      .promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: PLANNER_PROMPT(task, maxSubtasks), synthetic: true }] },
        query: { directory },
      })
      .then((result) => errorInfoFromResult(result)?.message ?? null)
      .catch((error) => (error instanceof Error ? error.message : String(error)))
    if (promptError) {
      log("[prism] split: planner prompt failed", { sessionID, error: promptError })
      return null
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const messagesResponse = await client.session
        .messages({ path: { id: sessionID }, query: { directory } })
        .catch(() => null)
      const text = messagesResponse ? lastAssistantText(messagesResponse.data) : null
      if (text !== null) {
        const parsed = subTaskPlanArraySchema.safeParse(extractJsonArray(text))
        if (parsed.success) return parsed.data
        log("[prism] split: planner output failed schema validation", {
          issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
        })
        return null
      }
      await sleep(500)
    }
    log("[prism] split: planner timed out", { sessionID })
    return null
  } finally {
    await client.session.abort({ path: { id: sessionID } }).catch(() => {})
  }
}

// Run the planner, retrying once on invalid output.
export async function planSplit(args: {
  client: PrismClient
  directory: string
  parentSessionID: string
  task: string
  model: ResolvedModel
  maxSubtasks?: number
  timeoutMs?: number
}): Promise<SubTaskPlan[] | null> {
  const maxSubtasks = args.maxSubtasks ?? MAX_SUBTASKS
  const timeoutMs = args.timeoutMs ?? PLANNER_SYNC_TIMEOUT_MS

  for (let attempt = 0; attempt < 2; attempt++) {
    const plans = await runPlannerOnce({ ...args, maxSubtasks, timeoutMs })
    if (plans) return plans
    log("[prism] split: planner attempt failed, retrying", { attempt: attempt + 1 })
  }
  return null
}
