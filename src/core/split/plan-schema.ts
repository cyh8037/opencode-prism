import { z } from "zod"
import { MAX_SUBTASKS } from "../../config/constants"

export interface SubTaskPlan {
  id: string
  title: string
  description: string
  dependsOn: string[]
}

export const subTaskPlanSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    dependsOn: z.array(z.string()).default([]),
  })
  .strict()

export const subTaskPlanArraySchema = z
  .array(subTaskPlanSchema)
  .min(1)
  .max(MAX_SUBTASKS)
  .superRefine((plans, ctx) => {
    const ids = new Set<string>()
    for (const plan of plans) {
      if (ids.has(plan.id)) {
        ctx.addIssue({ code: "custom", path: ["id"], message: `duplicate id: ${plan.id}` })
      }
      ids.add(plan.id)
    }
    for (const plan of plans) {
      for (const dep of plan.dependsOn) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: "custom",
            path: ["dependsOn"],
            message: `id ${plan.id} depends on unknown task ${dep}`,
          })
        }
      }
    }
    // cycle check via Kahn on the dependency graph
    const indegree = new Map(plans.map((plan) => [plan.id, plan.dependsOn.length]))
    const dependents = new Map<string, string[]>(plans.map((plan) => [plan.id, []]))
    for (const plan of plans) {
      for (const dep of plan.dependsOn) {
        dependents.get(dep)?.push(plan.id)
      }
    }
    const queue = plans.filter((plan) => plan.dependsOn.length === 0).map((plan) => plan.id)
    let visited = 0
    while (queue.length > 0) {
      const id = queue.shift()!
      visited++
      for (const next of dependents.get(id) ?? []) {
        const degree = (indegree.get(next) ?? 1) - 1
        indegree.set(next, degree)
        if (degree === 0) queue.push(next)
      }
    }
    if (visited !== plans.length) {
      ctx.addIssue({ code: "custom", message: "dependency graph contains a cycle" })
    }
  })
