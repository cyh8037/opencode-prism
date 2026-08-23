import { z } from "zod"

// Explicit vision model reference: "provider/model". Empty string means "not
// configured": automatic triggers skip interpretation and vision_look reports
// the model as unavailable. To disable the vision feature ENTIRELY (tool
// unregistered, no automatic interpretation) use vision.enabled = false.
export const visionModelSchema = z
  .string()
  .describe('解读模型引用 "provider/model"；空字符串 = 未配置（继承主会话模型）')
  .refine((value) => {
    if (value.trim().length === 0) return true // empty = disabled
    const core = value.trim()
    // whitespace is rejected: a variant suffix like "provider/model max" is
    // not supported
    return (
      !/\s/.test(core) && core.includes("/") && !core.startsWith("/") && !core.endsWith("/")
    )
  }, 'vision model must be "provider/model", or empty to disable')

export const prismConfigSchema = z.object({
  vision: z
    .object({
      // 总开关。false 时 vision_look 工具不注册、自动解读不触发，子会话的
      // 工具列表也移除 vision_look（bg_spawn 的读图指引随之失效）。
      enabled: z.boolean().describe("视觉功能总开关；false 完全关闭（默认 true）"),
      model: visionModelSchema,
      mode: z
        .enum(["sync", "async"])
        .describe("sync = 同步解读并拼入工具输出；async = 投后台任务，完成后通知回注"),
      tools: z
        .array(z.string().min(1))
        .optional()
        .describe("限定触发自动解读的工具名；缺省 = 所有工具都检查，[] = 不触发自动解读"),
    })
    .default({
      enabled: true,
      model: "",
      mode: "sync",
    }),
  background: z
    .object({
      concurrency: z.number().int().min(1),
    })
    .default({ concurrency: 5 }),
  split: z
    .object({
      // 单一开关同时门控 split_task 工具与 /split 命令：命令的任务模式借道
      // 工具执行（模板指示模型调用 split_task），工具不注册时命令无法执行。
      tool: z.boolean().describe("split_task 工具与 /split 命令入口；false 时两者都不注册（默认 true）"),
    })
    .default({ tool: true }),
})

export type PrismConfig = z.infer<typeof prismConfigSchema>
