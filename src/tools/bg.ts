import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { BackgroundManager } from "../core/background/manager"

// LLM-facing tools for the background engine. Commands (/bg, /split) are the
// primary UX; these tools let the model drive the same engine mid-task.
export function createBgTools(manager: BackgroundManager): Record<string, ToolDefinition> {
  return {
    bg_spawn: tool({
      description:
        "启动一个后台子任务（独立会话并行执行）。适合探索、研究、并行实现等可以异步进行的工作。任务结束后父会话会收到汇总通知。涉及图片时：子会话收不到附件，请在 prompt 中包含图片的本地路径/URL，并让子任务使用 vision_look 工具读图。",
      args: {
        description: tool.schema.string().describe("任务简述，用于通知和状态展示"),
        prompt: tool.schema.string().describe("子任务的完整指令"),
        agent: tool.schema.string().optional().describe("可选的 OpenCode agent 名"),
      },
      async execute(args: { description: string; prompt: string; agent?: string }, ctx) {
        try {
          const task = await manager.launch({
            description: args.description,
            prompt: args.prompt,
            parentSessionId: ctx.sessionID,
            agent: args.agent,
          })
          const model = task.model ? `模型 ${task.model.providerID}/${task.model.modelID}` : ""
          return `后台任务已入队: \`${task.id}\` (${task.description}) ${model}\n用 bg_output("${task.id}") 查询结果，bg_cancel("${task.id}") 取消。`
        } catch (error) {
          return `后台任务启动失败: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),

    bg_output: tool({
      description: "查询后台任务的状态或结果。",
      args: {
        taskId: tool.schema.string().describe("任务 id（bg_ 前缀）"),
      },
      async execute(args: { taskId: string }) {
        const task = manager.getTask(args.taskId)
        if (!task) return `任务不存在: ${args.taskId}`
        const lines = [`任务 \`${task.id}\`: ${task.description}`, `状态: ${task.status}`]
        if (task.error) lines.push(`错误: ${task.error}`)
        if (task.status === "running" || task.status === "pending") {
          const toolCalls = task.progress?.toolCalls ?? 0
          lines.push(`进度: ${toolCalls} 次工具调用${task.progress?.lastTool ? `，最近: ${task.progress.lastTool}` : ""}`)
        }
        if (task.resultText) lines.push(`\n结果:\n${task.resultText.slice(0, 2000)}`)
        return lines.join("\n")
      },
    }),

    bg_cancel: tool({
      description: "取消一个后台任务（abort 其子会话并释放并发槽）。",
      args: {
        taskId: tool.schema.string().describe("任务 id（bg_ 前缀）"),
      },
      async execute(args: { taskId: string }) {
        const cancelled = await manager.cancelTask(args.taskId, { source: "bg_cancel" })
        return cancelled ? `已取消任务 \`${args.taskId}\`` : `取消失败: 任务不存在或已结束 (${args.taskId})`
      },
    }),
  }
}
