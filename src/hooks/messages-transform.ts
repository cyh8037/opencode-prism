import type { VisionPipeline } from "../core/vision/pipeline"

// experimental.chat.messages.transform: fires right before every LLM call
// with the exact message array that will become the model prompt (the same
// array `toModelMessagesEffect` converts). Blocking here delays ONLY the LLM
// call — the message commit and the TUI are unaffected, which is what makes
// the two-phase sync interpretation possible: the chat.message hook returns
// immediately (message list renders instantly), and the interpretation is
// injected into the FIRST answer's context instead of into the conversation.
export function createMessagesTransformHook(args: { pipeline: VisionPipeline }) {
  return async (
    _input: unknown,
    output: {
      messages: Array<{ info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }>
    },
  ): Promise<void> => {
    if (!Array.isArray(output.messages) || output.messages.length === 0) return
    await args.pipeline.onMessagesTransform(output.messages)
  }
}
