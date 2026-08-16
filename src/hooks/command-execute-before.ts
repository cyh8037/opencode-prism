import type { BackgroundManager } from "../core/background/manager"
import type { SplitService } from "../core/split/service"
import type { PrismClient } from "../core/client-types"

type CommandInput = { command: string; sessionID: string; arguments: string }
type CommandOutput = { parts: Array<{ type: string; text?: string; [key: string]: unknown }> }

function pushText(output: CommandOutput, text: string): void {
  output.parts.push({ type: "text", text, synthetic: true })
}

function formatTaskTable(manager: BackgroundManager, sessionID: string): string {
  const tasks = manager.getTasksByParentSession(sessionID)
  if (tasks.length === 0) return "当前会话没有后台任务。"
  const rows = tasks
    .map((task) => {
      const model = task.model ? `${task.model.providerID}/${task.model.modelID}` : "-"
      const toolCalls = task.progress?.toolCalls ?? 0
      return `| \`${task.id}\` | ${task.description} | ${task.status} | ${model} | ${toolCalls} tool calls |`
    })
    .join("\n")
  return `| task_id | 描述 | 状态 | 模型 | 工具调用 |\n|---|---|---|---|---|\n${rows}`
}

function formatTaskOutput(manager: BackgroundManager, taskID: string, fullSession: boolean): string {
  const task = manager.getTask(taskID)
  if (!task) return `任务不存在: ${taskID}`
  const lines = [
    `任务 \`${taskID}\`: ${task.description}`,
    `状态: ${task.status}`,
  ]
  if (task.error) lines.push(`错误: ${task.error}`)
  if (task.model) lines.push(`模型: ${task.model.providerID}/${task.model.modelID}${task.retries > 0 ? ` (重试 ${task.retries} 次)` : ""}`)
  if (task.resultText) lines.push(`\n结果:\n${task.resultText.slice(0, 2000)}`)
  if (fullSession && task.sessionId) {
    lines.push(`\n完整会话: opencode attach http://localhost:4096 --session ${task.sessionId}`)
  }
  return lines.join("\n")
}

const FLAG_PATTERN = /--(dry-run|sequential)\b|--max\s+(\d+)/g

function parseSplitArgs(argumentsText: string): {
  task: string
  dryRun: boolean
  sequential: boolean
  max?: number
} {
  let dryRun = false
  let sequential = false
  let max: number | undefined
  let task = argumentsText
  for (const match of argumentsText.matchAll(FLAG_PATTERN)) {
    if (match[1] === "dry-run") dryRun = true
    if (match[1] === "sequential") sequential = true
    if (match[2]) max = Number(match[2])
    task = task.replace(match[0], "")
  }
  return { task: task.trim(), dryRun, sequential, max }
}

// Deterministic subcommands run natively in the hook (status/output/cancel and
// the full /split orchestration); free-form descriptions fall through to the
// command template + bg_spawn tools.
export function createCommandExecuteBeforeHook(args: {
  manager: BackgroundManager
  splitService: SplitService
  client: PrismClient
}) {
  return async (input: CommandInput, output: CommandOutput): Promise<void> => {
    const argumentsText = input.arguments.trim()

    if (input.command === "bg") {
      if (argumentsText === "status" || argumentsText === "list") {
        pushText(output, formatTaskTable(args.manager, input.sessionID))
        return
      }
      const outputMatch = argumentsText.match(/^(?:output|get)\s+(\S+)(\s+--full)?$/)
      if (outputMatch) {
        const taskID = outputMatch[1]!
        pushText(output, formatTaskOutput(args.manager, taskID, outputMatch[2] !== undefined))
        return
      }
      const cancelMatch = argumentsText.match(/^(?:cancel)\s+(\S+)$/)
      if (cancelMatch) {
        const taskID = cancelMatch[1]!
        const cancelled = await args.manager.cancelTask(taskID, { source: "/bg cancel" })
        pushText(output, cancelled ? `已取消任务 \`${taskID}\`` : `取消失败: 任务不存在或已结束 (${taskID})`)
        return
      }
      return
    }

    if (input.command === "split") {
      if (argumentsText === "status" || argumentsText === "list") {
        pushText(output, formatTaskTable(args.manager, input.sessionID))
        return
      }
      const outputMatch = argumentsText.match(/^(?:output|get)\s+(\S+)$/)
      if (outputMatch) {
        pushText(output, formatTaskOutput(args.manager, outputMatch[1]!, false))
        return
      }
      const cancelMatch = argumentsText.match(/^(?:cancel)\s+(\S+)$/)
      if (cancelMatch) {
        const cancelled = await args.manager.cancelTask(cancelMatch[1]!, { source: "/split cancel" })
        pushText(output, cancelled ? `已取消任务 \`${cancelMatch[1]}\`` : "取消失败: 任务不存在或已结束")
        return
      }

      const { task, dryRun, sequential, max } = parseSplitArgs(argumentsText)
      if (!task) {
        pushText(output, "用法: /split <任务描述> [--dry-run] [--sequential] [--max <n>]")
        return
      }
      const outcome = await args.splitService.split({
        sessionID: input.sessionID,
        task,
        dryRun,
        sequential,
        maxSubtasks: max,
      })
      pushText(output, outcome.message)
      return
    }
  }
}
