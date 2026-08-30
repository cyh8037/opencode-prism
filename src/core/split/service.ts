import { MAX_ACTIVE_SPLIT_RUNS, MAX_SUBTASKS } from "../../config/constants"
import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
import type { BackgroundManager } from "../background/manager"
import type { PrismClient } from "../client-types"
import type { PromptGate } from "../prompt-gate"
import { checkSplitIntent, sanitizeIntentReason, type SplitIntent } from "./intent"
import type { SubTaskPlan } from "./plan-schema"
import { planSplit } from "./planner"
import { layerPlans } from "./scheduler"
import { buildSplitReport, runSplit, type SplitRunResult } from "./scheduler"
import { SplitRunRegistry } from "./registry"

export interface SplitServiceDeps {
  client: PrismClient
  directory: string
  manager: BackgroundManager
  gate: PromptGate
  registry: SplitRunRegistry
  resolvePlannerModel: (sessionID: string) => Promise<ResolvedModel | undefined>
  /** config.split.intentCheck（插件加载时读取）：开启时拆分前先做意图判定。 */
  intentCheckEnabled?: boolean
  /** TUI 环境探测（插件加载时读取）：false 时子会话查看指引不含 TUI 键位。 */
  tuiNavigation?: boolean
  logger?: typeof log
}

export interface SplitRequest {
  sessionID: string
  task: string
  dryRun?: boolean
  sequential?: boolean
  maxSubtasks?: number
}

export interface SplitOutcome {
  kind: "dry-run" | "launched" | "planner-failed" | "unresolvable-planner-model" | "skipped-intent" | "run-limit"
  message: string
  run?: SplitRunResult
}

// End-to-end /split orchestration: planner -> DAG scheduler -> aggregation.
export class SplitService {
  private logger: typeof log

  constructor(private deps: SplitServiceDeps) {
    this.logger = deps.logger ?? log
  }

  async split(request: SplitRequest): Promise<SplitOutcome> {
    // 并发 run 上限：模型 autoTrigger 下连续 split_task（或用户连按 /split）
    // 会叠出多组子任务互相抢并发槽、看板难以阅读。best-effort（两次并发
    // split 的检查窗口内仍可能同时通过），语义是防失控而非硬隔离。
    const activeRuns = this.deps.registry
      .getRunsByParentSession(request.sessionID)
      .filter((entry) => !entry.settled).length
    if (activeRuns >= MAX_ACTIVE_SPLIT_RUNS) {
      return {
        kind: "run-limit",
        message: `已有 ${activeRuns} 个拆分任务在执行（上限 ${MAX_ACTIVE_SPLIT_RUNS}）。请等待其完成，或用 /split cancel <sp_run_id> 取消后再试；/split status 可查看进行中的 run。`,
      }
    }

    // Single source of the subtask bounds for BOTH entry points (/split
    // command and split_task tool): out-of-range or non-integer values fall
    // back to the default instead of producing a contradictory planner
    // prompt ("2 到 1 个子任务") or a plan the schema rejects wholesale.
    const maxSubtasks =
      request.maxSubtasks !== undefined && Number.isInteger(request.maxSubtasks)
        ? Math.min(Math.max(request.maxSubtasks, 2), MAX_SUBTASKS)
        : undefined

    const plannerModel = await this.deps.resolvePlannerModel(request.sessionID)
    if (!plannerModel) {
      return {
        kind: "unresolvable-planner-model",
        message: "无法确定主会话的当前模型，规划器无法启动",
      }
    }

    // 意图判定（config.split.intentCheck）：direct 一律返回 skipped-intent，
    // dry-run 同入口（消息注明是预览判定，没有计划可展示）。checkSplitIntent
    // 自身 fail-open（任何失败视为可拆分），这里的 try/catch 只是兜住意外的
    // 同步 throw —— 两层都不得让意图识别成为 /split 的可用性单点。
    if (this.deps.intentCheckEnabled) {
      let intent: SplitIntent = { intent: "split" }
      try {
        intent = await checkSplitIntent({
          client: this.deps.client,
          directory: this.deps.directory,
          parentSessionID: request.sessionID,
          task: request.task,
          model: plannerModel,
        })
      } catch (error) {
        this.logger("[prism] split: intent check threw; failing open", { error })
      }
      if (intent.intent === "direct") {
        const reason = sanitizeIntentReason(intent.reason)
        const preview = request.dryRun ? "（预览判定，未执行）" : ""
        return {
          kind: "skipped-intent",
          message:
            `意图识别：该任务无需拆分${reason ? `（${reason}）` : ""}。${preview}`
            + "建议直接执行；确认要拆分可补充任务细节后重试，"
            + "或设置 split.intentCheck=false（需重启 opencode）。",
        }
      }
    }

    // planSplit never throws in practice, but a network rejection must not
    // escape the command hook — degrade to the same planner-failed outcome.
    let plans: Awaited<ReturnType<typeof planSplit>> = null
    try {
      plans = await planSplit({
        client: this.deps.client,
        directory: this.deps.directory,
        parentSessionID: request.sessionID,
        task: request.task,
        model: plannerModel,
        maxSubtasks,
      })
    } catch (error) {
      this.logger("[prism] split: planner threw", { error })
    }

    if (!plans) {
      return {
        kind: "planner-failed",
        message: "规划器未能产出有效的拆分计划（两次尝试均失败），请把任务描述得更具体，或直接单任务执行",
      }
    }

    if (request.dryRun) {
      const renderPlan = (prefix: string, plan: SubTaskPlan) => {
        const deps = plan.dependsOn.length > 0 ? ` (依赖: ${plan.dependsOn.join(", ")})` : ""
        return `${prefix} ${plan.id} ${plan.title}${deps}\n  ${plan.description}`
      }
      const layers = layerPlans(plans)
      // Sequential runs launch in plan order (the scheduler's sequential
      // loop), not wave order — render the actual execution order. Parallel
      // runs render topological waves, but each task starts as soon as ITS
      // OWN dependencies finish (ASAP), so the wave text must not imply a
      // whole-wave barrier.
      const message = request.sequential
        ? `拆分计划（${plans.length} 个子任务，串行执行，未执行）:\n执行顺序:\n${plans
            .map((plan, index) => renderPlan(`${index + 1}.`, plan))
            .join("\n")}`
        : `拆分计划（${plans.length} 个子任务，分 ${layers.length} 波执行，未执行）:\n${layers
            .map((layer, index) => {
              const header =
                index === 0
                  ? "第 1 波（无依赖，立即启动）:"
                  : `第 ${index + 1} 波（依赖在前一波；各任务在其依赖完成后即启动，不等整波全部结束）:`
              return `${header}\n${layer.map((plan) => renderPlan("-", plan)).join("\n")}`
            })
            .join("\n")}`
      return { kind: "dry-run", message }
    }

    // run id 先于启动生成：runSplit 要拿它当子任务的 notificationGroup
    // （父会话在每个 run 收尾只被唤醒一次，同会话独立任务的通知不受其
    // 门控），register 时原样传入保持 id 一致。
    const runId = this.deps.registry.generateRunId()
    const run = runSplit(this.deps.manager, {
      plans,
      parentSessionId: request.sessionID,
      basePromptPrefix: `你在执行一个更大任务的子任务。整体任务: ${request.task}`,
      sequential: request.sequential,
      notificationGroupId: runId,
    })

    // 登记到 SplitRunRegistry:/split status 看板的数据源。tasksByPlanID /
    // skippedPlanIDs 是实时引用,状态在查询时推导;run 结束时标记 settled,
    // TTL 锚点随之切换(运行中条目永不清理,见 registry.ts 文件头注释)。
    const registryEntry = this.deps.registry.register({
      id: runId,
      sessionID: request.sessionID,
      plans,
      tasksByPlanID: run.tasksByPlanID,
      skippedPlanIDs: run.skippedPlanIDs,
      sequential: request.sequential ?? false,
      settled: false,
      createdAt: new Date(),
    })

    // .catch on the tail: an unexpected throw in this callback (Invariant #1 —
    // hooks never escape, but this is a fire-and-forget promise chain outside
    // any hook) would surface as an unhandled rejection in the host process,
    // whose stderr leaks into the TUI. The aggregation is best-effort; a throw
    // must not crash the process.
    // settled 在 fulfill/reject 两条路径都必须落盘:prune 只回收 settled
    // 条目,run.done 一旦 reject 而 settled 未置位,条目就会永远滞留在
    // registry(reject 本身由下方聚合链的 .catch 兜底,这里只负责登记)。
    void run.done.then(
      () => {
        registryEntry.settled = true
        registryEntry.settledAt = new Date()
      },
      (error) => {
        this.logger("[prism] split: run.done rejected; marking registry entry settled", {
          sessionID: request.sessionID,
          error,
        })
        registryEntry.settled = true
        registryEntry.settledAt = new Date()
      },
    )
    void run.done
      .then(async () => {
        const text = buildSplitReport(run.tasksByPlanID, plans, run.skippedPlanIDs)
        // 升级为退避阶梯重试（覆盖最长 30+ 秒的主会话 busy 窗口）：汇总
        // 报告是 SKIPPED 计划的唯一记录，永久丢失前必须穷尽重试。重试语义
        // 收敛在 gate.dispatchWithRetry（与后台完成通知共用同一阶梯）。
        const result = await this.deps.gate.dispatchWithRetry({
          sessionID: request.sessionID,
          source: "split-aggregation",
          text,
        })

        if (result.status === "failed") {
          // The report is the only record of the SKIPPED plans (the per-task
          // batch notices never mention unlaunched ones) — once it is lost to
          // the parent conversation, the log file is the only place it can
          // still be recovered from.
          this.logger("[prism] split: aggregation dispatch failed permanently (report lost to chat, preserved below)", {
            sessionID: request.sessionID,
            error: result.error,
            report: text,
          })
          // 兜底提示：通过 Toast 告知用户拆分已结束，引导通过 status 查看
          const toast = this.deps.client.tui.showToast?.({
            body: {
              title: "Prism Split",
              message: "拆分任务已全部完成（主会话忙未注入，可通过 /split status 查看明细）",
              variant: "warning",
              duration: 8000,
            },
          })
          if (toast) void toast.catch(() => {})
        }
      })
      .catch((error) => {
        this.logger("[prism] split: aggregation failed (swallowed)", { sessionID: request.sessionID, error })
      })

    return {
      kind: "launched",
      message: this.deps.tuiNavigation === false
        ? `拆分计划已启动：${plans.length} 个子任务，按依赖分层并发执行。子任务进度可通过 /split status 与 bg_output 查看；全部结束后汇总报告回注主会话。`
        : `拆分计划已启动：${plans.length} 个子任务，按依赖分层并发执行。子任务进度可通过 TUI 子会话导航（leader 键+↓ 进入）与 /split status 查看；全部结束后汇总报告回注主会话。`,
      run,
    }
  }
}
