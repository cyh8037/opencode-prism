import { z } from "zod"

// Explicit vision model reference: "provider/model". Empty string disables
// the vision feature: automatic triggers skip interpretation and vision_look
// reports the model as unavailable.
export const visionModelSchema = z
  .string()
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
      model: visionModelSchema,
      mode: z.enum(["sync", "background"]),
      tools: z.array(z.string().min(1)).optional(),
    })
    .default({
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
      // split_task tool (model-initiated splits). The /split command is always
      // available; this only gates the LLM-facing tool entry point.
      tool: z.boolean(),
    })
    .default({ tool: true }),
})

export type PrismConfig = z.infer<typeof prismConfigSchema>
