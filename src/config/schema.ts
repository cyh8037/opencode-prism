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
      chatImages: z.boolean(),
    })
    .default({
      model: "",
      mode: "sync",
      chatImages: true,
    }),
  background: z
    .object({
      concurrency: z.number().int().min(1),
    })
    .default({ concurrency: 5 }),
  tmux: z
    .object({
      enabled: z.boolean(),
      layout: z.enum(["main-vertical", "main-horizontal", "tiled", "even-horizontal", "even-vertical"]),
      isolation: z.enum(["inline", "window", "session"]),
    })
    .default({ enabled: true, layout: "main-vertical", isolation: "inline" }),
})

export type PrismConfig = z.infer<typeof prismConfigSchema>
