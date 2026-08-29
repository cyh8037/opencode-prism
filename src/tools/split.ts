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
  // 爆炸半径大于 bg_spawn（规划器 + N 个子任务），准则边界相应更紧；与
  // bg_spawn 准则互恰：少量独立并行任务归 bg_spawn，结构性复合任务归这里。
  const autoTriggerGuidance =
    opts.autoTrigger ?? true
      ? "\n【自主触发准则】以下场景可主动调用（无需用户显式要求 /split），启动后立即告知用户已转入拆分执行：\n1. 任务包含 3 个以上可识别的独立子工作，且子工作间有关联或需要统一汇总，或有明确的依赖顺序；\n2. 涉及多个模块/文件的并行改动，或调研+实现类的复合任务。\n【不适用场景】单步简单任务；需要用户实时确认的多轮交互；与主会话正在编辑的同一批文件冲突；删除数据、生产环境变更等破坏性操作；仅 1-2 个互不依赖的并行任务（用 bg_spawn 更合适）。无法确定是否适用时，不调用。"
      : ""
  return {
    split_task: tool({
      description:
        "把复杂任务拆成多个子任务并按依赖关系并发执行（规划器拆分 + 依赖调度 + 完成后自动汇总回注本会话）。适用：任务有 3 个以上可识别的步骤、涉及多个文件/模块、或步骤间有依赖顺序。不适用：只有一两个简单步骤、或子任务之间毫无关联且不需要汇总（这种情况直接自己做或用 bg_spawn）。拆分和执行由插件原生完成，返回的是启动结果；子任务全部结束后会自动收到汇总通知，不要轮询。" +
        autoTriggerGuidance,
      args: {
        task: tool.schema
          .string()
          .min(1)
          .describe("要拆分执行的整体任务描述，写清楚目标和边界，越具体拆分越准"),
        dry_run: tool.schema
          .boolean()
          .optional()
          .describe("只生成拆分计划不执行（用于先给用户确认计划，确认后再次调用并省略此参数）"),
        sequential: tool.schema.boolean().optional().describe("子任务串行执行（默认按依赖分层并发）"),
        max: tool.schema.number().optional().describe(`子任务数量上限（2-${MAX_SUBTASKS}，默认 ${MAX_SUBTASKS}）`),
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
          return `拆分失败: ${error instanceof Error ? error.message : String(error)}。可以直接单任务执行，或让用户用 /split 重试`
        }
      },
    }),
  }
}
