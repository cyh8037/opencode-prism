import { MAX_SUBTASKS, PLANNER_SYNC_TIMEOUT_MS } from "../../config/constants"
import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
import type { PrismClient } from "../client-types"
import { runJsonPromptSession } from "./json-prompt"
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

async function runPlannerOnce(args: {
  client: PrismClient
  directory: string
  parentSessionID: string
  task: string
  model: ResolvedModel
  timeoutMs: number
  maxSubtasks: number
}): Promise<SubTaskPlan[] | null> {
  // 会话生命周期（create → prompt → 轮询 → abort）与工具面防线由
  // runJsonPromptSession 统一承担，本函数只负责规划器自己的解析。
  const text = await runJsonPromptSession({
    client: args.client,
    directory: args.directory,
    parentSessionID: args.parentSessionID,
    title: "prism split planner",
    text: PLANNER_PROMPT(args.task, args.maxSubtasks),
    model: args.model,
    timeoutMs: args.timeoutMs,
  })
  if (!text) return null

  const parsed = subTaskPlanArraySchema.safeParse(extractJsonArray(text))
  if (parsed.success) return parsed.data
  log("[prism] split: planner output failed schema validation", {
    issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
  })
  return null
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
