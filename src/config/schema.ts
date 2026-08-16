import { z } from "zod"
import { VARIANT_VALUES } from "./constants"

// Explicit vision model reference: "provider/model" with an optional variant
// suffix. Empty string disables the vision feature.
export const visionModelSchema = z
  .string()
  .refine((value) => {
    if (value.trim().length === 0) return true // empty = disabled
    const tokens = value.trim().split(/\s+/)
    const maybeVariant = tokens[tokens.length - 1]
    if (tokens.length >= 2 && !VARIANT_VALUES.includes(maybeVariant as (typeof VARIANT_VALUES)[number])) {
      return false
    }
    const core = tokens[0] ?? ""
    return core.includes("/") && !core.startsWith("/") && !core.endsWith("/")
  }, 'vision model must be "provider/model" with an optional variant suffix (off|low|medium|high|xhigh|max), or empty to disable')

export const prismConfigSchema = z.object({
  vision: z
    .object({
      model: visionModelSchema,
      mode: z.enum(["sync", "background"]),
      tools: z.array(z.string().min(1)).optional(),
      chatImages: z.boolean(),
    })
    .default({
      model: "anthropic/claude-fable-5 xhigh",
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
