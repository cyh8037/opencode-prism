import { MAX_SUBTASKS } from "../../config/constants"
import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
import type { BackgroundManager } from "../background/manager"
import type { PrismClient } from "../client-types"
import type { PromptGate } from "../prompt-gate"
import type { SubTaskPlan } from "./plan-schema"
import { planSplit } from "./planner"
import { layerPlans } from "./scheduler"
import { buildSplitReport, runSplit, type SplitRunResult } from "./scheduler"

export interface SplitServiceDeps {
  client: PrismClient
  directory: string
  manager: BackgroundManager
  gate: PromptGate
  resolvePlannerModel: (sessionID: string) => Promise<ResolvedModel | undefined>
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
  kind: "dry-run" | "launched" | "planner-failed" | "unresolvable-planner-model"
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

    const run = runSplit(this.deps.manager, {
      plans,
      parentSessionId: request.sessionID,
      basePromptPrefix: `你在执行一个更大任务的子任务。整体任务: ${request.task}`,
      sequential: request.sequential,
    })

    void run.done.then(async () => {
      const text = buildSplitReport(run.tasksByPlanID, plans, run.skippedPlanIDs)
      const dispatch = () =>
        this.deps.gate.dispatch({
          sessionID: request.sessionID,
          source: "split-aggregation",
          text,
        })
      let result = await dispatch()
      if (result.status === "failed") {
        // The aggregation is the only record of the whole run — callers do not
        // re-enqueue, so give it one more chance after a pause.
        this.logger("[prism] split: aggregation dispatch failed, retrying once", {
          sessionID: request.sessionID,
          error: result.error,
        })
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        result = await dispatch()
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
        }
      }
    })

    return {
      kind: "launched",
      message: `拆分计划已启动：${plans.length} 个子任务，按依赖分层并发执行。子任务进度通过 toast 展示，全部完成后会收到汇总通知。`,
      run,
    }
  }
}
