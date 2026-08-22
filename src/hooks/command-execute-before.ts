import { MAX_SUBTASKS } from "../config/constants"
import type { BackgroundManager } from "../core/background/manager"
import type { BgTask } from "../core/background/types"
import type { SplitService } from "../core/split/service"
import type { VisionPipeline } from "../core/vision/pipeline"
import { guessImageMime } from "../core/vision/detector"
import { VISION_NO_MODEL_HINT } from "../core/vision/interpreter"

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

function formatTaskOutput(manager: BackgroundManager, taskID: string, fullSession: boolean, serverUrl: string): string {
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
    lines.push(`\n完整会话: opencode attach ${serverUrl} --session ${task.sessionId}`)
    if (process.env.OPENCODE_SERVER_PASSWORD) {
      lines.push("（服务端已启用密码认证，attach 前需设置 OPENCODE_SERVER_PASSWORD 环境变量）")
    }
  }
  return lines.join("\n")
}

// Tasks are owned by the session that spawned them: a /bg or /split command
// typed in another session (e.g. a child pane) must not read or cancel them.
function checkTaskOwnership(
  manager: BackgroundManager,
  sessionID: string,
  taskID: string,
): { ok: true; task: BgTask } | { ok: false; error: string } {
  const task = manager.getTask(taskID)
  if (!task) return { ok: false, error: `任务不存在: ${taskID}` }
  if (task.parentSessionId !== sessionID) {
    return { ok: false, error: `无权操作其他会话的任务: ${taskID}` }
  }
  return { ok: true, task }
}

const FLAG_PATTERN = /--(dry-run|sequential)\b|--max(?:\s+|=)(\d+)/g

// /vision <path/URL ... | last> [--goal <text>]: everything after --goal is
// the goal (it may contain spaces); the rest splits into image references.
function parseVisionArgs(argumentsText: string): { targets: string[]; goal?: string } {
  let goal: string | undefined
  let remainder = argumentsText
  const goalMatch = remainder.match(/--goal(?:=|\s+)([\s\S]+)$/)
  if (goalMatch) {
    goal = goalMatch[1]!.trim()
    remainder = remainder.slice(0, goalMatch.index)
  }
  const targets = remainder.trim().split(/\s+/).filter(Boolean)
  return { targets, goal }
}

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
    if (match[2]) {
      // Clamp to the planner bounds; garbage values are ignored. The planner
      // prompt promises "2 到 N" subtasks, so 0/1 would contradict it.
      const parsedMax = Number(match[2])
      if (Number.isInteger(parsedMax)) max = Math.min(Math.max(parsedMax, 2), MAX_SUBTASKS)
    }
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
  serverUrl: string
  vision: VisionPipeline
}) {
  return async (input: CommandInput, output: CommandOutput): Promise<void> => {
    const argumentsText = input.arguments.trim()

    if (input.command === "vision") {
      const { targets, goal } = parseVisionArgs(argumentsText)
      if (targets.length === 0) {
        pushText(output, "用法: /vision <图片路径/URL ... | last> [--goal <关注点>]\nlast = 解读本会话最近的一张图片")
        return
      }
      // "last" resolves the most recent image message of THIS session — a
      // user pasting an image has no URL the command arguments could carry.
      if (targets.length === 1 && targets[0] === "last") {
        const result = await args.vision.lookLatest(input.sessionID, goal)
        if (result.notFound) {
          pushText(output, "当前会话没有找到任何图片消息。请改用图片的本地路径/URL")
        } else {
          pushText(output, result.text ?? VISION_NO_MODEL_HINT)
        }
        return
      }
      const images = targets.map((target) => ({ mime: guessImageMime(target), url: target }))
      const text = await args.vision.look(input.sessionID, images, goal)
      pushText(output, text ?? VISION_NO_MODEL_HINT)
      return
    }

    if (input.command === "bg") {
      if (argumentsText === "status" || argumentsText === "list") {
        pushText(output, formatTaskTable(args.manager, input.sessionID))
        return
      }
      const outputMatch = argumentsText.match(/^(?:output|get)\s+(\S+)(\s+--full)?$/)
      if (outputMatch) {
        const taskID = outputMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        pushText(output, formatTaskOutput(args.manager, taskID, outputMatch[2] !== undefined, args.serverUrl))
        return
      }
      const cancelMatch = argumentsText.match(/^(?:cancel)\s+(\S+)$/)
      if (cancelMatch) {
        const taskID = cancelMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        const cancelled = await args.manager.cancelTask(taskID, { source: "/bg cancel" })
        pushText(output, cancelled ? `已取消任务 \`${taskID}\`` : `取消失败: 任务不存在或已结束 (${taskID})`)
        return
      }
      if (argumentsText === "cancel") {
        await args.manager.cancelAllByParentSession(input.sessionID, "/bg cancel")
        pushText(output, "已取消当前会话的全部后台任务")
        return
      }
      // resume <task_id> <追问>: continue a finished task's child session in
      // place — the child keeps its context, no re-launch needed.
      const resumeMatch = argumentsText.match(/^resume\s+(\S+)\s+([\s\S]+)$/)
      if (resumeMatch) {
        const taskID = resumeMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        try {
          await args.manager.resume(taskID, resumeMatch[2]!)
          pushText(output, `任务 \`${taskID}\` 已恢复运行（追问已发送到其子会话），结束后会收到通知`)
        } catch (error) {
          pushText(output, `恢复失败: ${error instanceof Error ? error.message : String(error)}`)
        }
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
        const taskID = outputMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        pushText(output, formatTaskOutput(args.manager, taskID, false, args.serverUrl))
        return
      }
      const cancelMatch = argumentsText.match(/^(?:cancel)\s+(\S+)$/)
      if (cancelMatch) {
        const taskID = cancelMatch[1]!
        const owned = checkTaskOwnership(args.manager, input.sessionID, taskID)
        if (!owned.ok) {
          pushText(output, owned.error)
          return
        }
        const cancelled = await args.manager.cancelTask(taskID, { source: "/split cancel" })
        pushText(output, cancelled ? `已取消任务 \`${taskID}\`` : "取消失败: 任务不存在或已结束")
        return
      }
      if (argumentsText === "cancel") {
        await args.manager.cancelAllByParentSession(input.sessionID, "/split cancel")
        pushText(output, "已取消当前会话的全部后台任务")
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
