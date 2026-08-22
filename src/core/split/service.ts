import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
import type { BackgroundManager } from "../background/manager"
import type { PrismClient } from "../client-types"
import type { PromptGate } from "../prompt-gate"
import { planSplit } from "./planner"
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
        maxSubtasks: request.maxSubtasks,
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
      const planLines = plans
        .map((plan) => {
          const deps = plan.dependsOn.length > 0 ? ` (依赖: ${plan.dependsOn.join(", ")})` : ""
          return `- ${plan.id} ${plan.title}${deps}\n  ${plan.description}`
        })
        .join("\n")
      return {
        kind: "dry-run",
        message: `拆分计划（${plans.length} 个子任务，未执行）:\n${planLines}`,
      }
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
          this.logger("[prism] split: aggregation dispatch failed permanently (report lost)", {
            sessionID: request.sessionID,
            error: result.error,
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
