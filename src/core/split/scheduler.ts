import { MAX_SUBTASKS } from "../../config/constants"
import type { BgTask, LaunchInput } from "../background/types"
import type { BackgroundManager } from "../background/manager"
import type { SubTaskPlan } from "./plan-schema"

export interface SplitRunOptions {
  plans: SubTaskPlan[]
  parentSessionId: string
  basePromptPrefix?: string
  sequential?: boolean
}

export interface SplitRunResult {
  /** Live map: plan id -> background task (filled as tasks launch). */
  tasksByPlanID: Map<string, BgTask>
  failed: BgTask[]
  /** Resolves when every launched subtask reached a terminal status. */
  done: Promise<void>
}

const TERMINAL = new Set(["completed", "error", "cancelled"])

// DAG scheduler: topological layering. Layer 0 launches immediately; a task's
// dependents launch once all their dependencies reached a terminal status.
// Completion events drive the schedule via BackgroundManager.onTaskTerminal.
export function runSplit(manager: BackgroundManager, options: SplitRunOptions): SplitRunResult {
  const plans = options.plans.slice(0, MAX_SUBTASKS)
  const tasksByPlanID = new Map<string, BgTask>()
  const launchedPlanIDs = new Set<string>()
  const terminalPlanIDs = new Set<string>()

  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const planForTask = (task: BgTask): string | undefined => {
    for (const [planID, planTask] of tasksByPlanID.entries()) {
      if (planTask === task) return planID
    }
    return undefined
  }

  const checkSettled = (): void => {
    // Settled only when EVERY plan is terminal: launched-and-finished, or
    // marked terminal by a launch failure. Not-yet-launched plans keep the
    // run open (their dependents may still be scheduled).
    const allTerminal = plans.every((plan) => {
      if (terminalPlanIDs.has(plan.id)) return true
      const task = tasksByPlanID.get(plan.id)
      return task !== undefined && TERMINAL.has(task.status)
    })
    if (allTerminal) resolveDone()
  }

  const launchReady = (): void => {
    if (options.sequential) {
      const anyActive = Array.from(tasksByPlanID.values()).some(
        (task) => task.status === "running" || task.status === "pending",
      )
      if (anyActive) return
    }

    for (const plan of plans) {
      if (launchedPlanIDs.has(plan.id)) continue

      const depsTerminal = plan.dependsOn.every((depID) => terminalPlanIDs.has(depID))
      if (!depsTerminal) continue

      launchedPlanIDs.add(plan.id)
      const input: LaunchInput = {
        description: `${plan.id}: ${plan.title}`,
        prompt: [options.basePromptPrefix, plan.description].filter(Boolean).join("\n\n"),
        parentSessionId: options.parentSessionId,
      }
      void manager
        .launch(input)
        .then((task) => {
          tasksByPlanID.set(plan.id, task)
        })
        .catch(() => {
          // launch failure: mark the plan terminal so dependents can proceed
          terminalPlanIDs.add(plan.id)
          checkSettled()
          launchReady()
        })

      if (options.sequential) return
    }
  }

  manager.onTaskTerminal((task) => {
    const planID = planForTask(task)
    if (planID) terminalPlanIDs.add(planID)
    launchReady()
    checkSettled()
  })

  launchReady()
  if (plans.length === 0) resolveDone()

  return {
    tasksByPlanID,
    get failed() {
      return Array.from(tasksByPlanID.values()).filter(
        (task) => task.status === "error" || task.status === "cancelled",
      )
    },
    done,
  }
}

export function buildSplitReport(tasksByPlanID: Map<string, BgTask>, plans: SubTaskPlan[]): string {
  const lines = ["<system-reminder>", "[PRISM SPLIT REPORT]", ""]
  for (const plan of plans) {
    const task = tasksByPlanID.get(plan.id)
    if (!task) {
      lines.push(`- ${plan.id} ${plan.title}: 未启动`)
      continue
    }
    const error = task.error ? `: ${task.error.slice(0, 120)}` : ""
    const result = task.resultText ? `\n  结果: ${task.resultText.slice(0, 200)}` : ""
    lines.push(`- ${plan.id} ${plan.title}: ${task.status.toUpperCase()}${error}${result}`)
  }
  lines.push("", "整合子任务结果，完成整体任务的验证与收尾。", "</system-reminder>")
  return lines.join("\n")
}
