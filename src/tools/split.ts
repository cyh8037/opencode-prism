import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MAX_SUBTASKS } from "../config/constants"
import type { SplitService } from "../core/split/service"

// The split pipeline (planner -> DAG scheduler -> aggregation) exposed as a
// tool. TWO entry paths share it: the main agent self-initiating a split,
// and the /split command — its template instructs the model to call this
// tool, which keeps the full round streaming in the TUI instead of blocking
// the command hook for the planner's LLM round. Gated by config split.tool
// (default on); when off, the /split command is not registered either.
//
// autoTrigger（策略 A，与 background.autoTrigger 完全同构）:开启时在工具
// 描述拼接"自主触发准则"，模型可根据任务复杂度主动调用 split_task，不必等
// 用户输入 /split。关闭时描述维持旧文本。插件加载时读取，切换需重启
// opencode。children never see this guidance: childToolFilters disables
// split_task in every prism-managed child session.
export function createSplitTool(
  splitService: SplitService,
  opts: { autoTrigger?: boolean } = {},
): Record<string, ToolDefinition> {
  const autoTriggerGuidance =
    opts.autoTrigger ?? true
      ? "\n[Autonomous Trigger Guidelines] You may proactively invoke this tool (without explicit user request) and immediately inform the user that execution has moved to task splitting for:\n1. Tasks containing 3+ distinct subtasks that are interrelated, require consolidated aggregation, or have clear dependency order;\n2. Parallel changes across multiple modules/files, or compound research-and-implementation tasks.\n[Non-applicable Scenarios] Single-step simple tasks; interactive multi-turn dialogues requiring real-time user confirmation; conflicts with files currently being edited in the parent session; destructive operations (deleting data, modifying production environments); 1-2 independent parallel tasks without dependency (bg_spawn is preferred). Do not invoke if uncertain."
      : ""
  return {
    split_task: tool({
      description:
        "Split a complex task into multiple subtasks and execute concurrently based on dependencies (planner breakdown + DAG scheduling + automatic aggregation back into this session). Applicable: tasks with 3+ distinct steps, touching multiple files/modules, or having dependency order. Non-applicable: 1-2 simple steps, or completely unrelated subtasks needing no aggregation (perform directly or use bg_spawn). Splitting and execution are handled natively; summary notification arrives automatically upon completion, do not poll." +
        autoTriggerGuidance,
      args: {
        task: tool.schema
          .string()
          .min(1)
          .describe("Overall task description to split and execute, specifying goals and boundaries clearly"),
        dry_run: tool.schema
          .boolean()
          .optional()
          .describe("Generate split plan only without execution (for user review before actual execution)"),
        sequential: tool.schema.boolean().optional().describe("Execute subtasks sequentially (default is dependency-based concurrent tiers)"),
        max: tool.schema.number().optional().describe(`Subtask count upper limit (2-${MAX_SUBTASKS}, default ${MAX_SUBTASKS})`),
      },
      async execute(
        args: { task: string; dry_run?: boolean; sequential?: boolean; max?: number },
        ctx: { sessionID: string },
      ) {
        try {
          const outcome = await splitService.split({
            sessionID: ctx.sessionID,
            task: args.task,
            dryRun: args.dry_run ?? false,
            sequential: args.sequential ?? false,
            maxSubtasks: args.max,
          })
          return outcome.message
        } catch (error) {
          // split() already degrades planner failures to outcomes; a throw
          // here means something structural broke before planning.
          return `Task splitting failed: ${error instanceof Error ? error.message : String(error)}. You can proceed as a single task or have the user retry with /split.`
        }
      },
    }),
  }
}
