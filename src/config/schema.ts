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
      // 对话贴图处理方式（零阻塞，纯提醒）：hint = 在模型回合前注入提醒文本，
      // 告知图片已保存在会话中、请调用 vision_look(["last"]) 读取（默认）；
      // false = 不注入，完全依赖模型自主调用工具。auto（自动解读并注入结果）
      // 为预留值，当前版本尚未实现，配置为 auto 时按 hint 行为执行。
      chatImages: z
        .union([z.enum(["auto", "hint"]), z.literal(false)])
        .default("hint")
        .describe('对话贴图：hint = 注入"请调用 vision_look"提醒（默认）；false = 不注入；auto = 预留（自动解读，未实现）'),
      tools: z
        .array(z.string().min(1))
        .optional()
        .describe("限定触发自动解读的工具名；缺省 = 所有工具都检查，[] = 不触发自动解读"),
    })
    .default({
      enabled: true,
      model: "",
      mode: "sync",
      chatImages: "hint",
    }),
  background: z
    .object({
      concurrency: z.number().int().min(1),
      // 策略 A 自动触发的总开关:true 时 bg_spawn 的工具描述拼接"自主触发
      // 准则",模型可主动将耗时/独立任务放入后台;false 回退到旧描述,仅按
      // 用户显式要求启动。插件加载时读取,切换需重启 opencode。
      autoTrigger: z.boolean().describe("模型可自主调用 bg_spawn 将耗时/独立任务放入后台（默认 true）"),
    })
    .default({ concurrency: 5, autoTrigger: true }),
  split: z
    .object({
      // 单一开关同时门控 split_task 工具与 /split 命令：命令的任务模式借道
      // 工具执行（模板指示模型调用 split_task），工具不注册时命令无法执行。
      tool: z.boolean().describe("split_task 工具与 /split 命令入口；false 时两者都不注册（默认 true）"),
      // 拆分前的意图识别（一次性分类子会话，fail-open）：direct 判定返回原因
      // 并跳过拆分。默认开启——多一跳 LLM 调用的延迟/成本换取防误拆兜底
      // （autoTrigger 默认同为 true，模型自主触发的拆分默认被此判定兜底）。
      intentCheck: z
        .boolean()
        .describe("拆分前先做意图识别：简单任务判定为无需拆分并返回原因（默认 true；false 可省去判定的一次额外模型调用）"),
      // 策略 A 同构：true 时 split_task 的工具描述拼接"自主触发准则"，模型可
      // 主动拆分。爆炸半径大于 bg_spawn（规划器 + N 个子任务），默认由
      // intentCheck 兜底防误拆。插件加载时读取，切换需重启 opencode。
      autoTrigger: z
        .boolean()
        .describe("模型可根据任务复杂度自主调用 split_task 拆分执行，无需用户输入 /split（默认 true；自主触发的拆分默认被 intentCheck 兜底）"),
    })
    .default({ tool: true, intentCheck: true, autoTrigger: true }),
})

export type PrismConfig = z.infer<typeof prismConfigSchema>
