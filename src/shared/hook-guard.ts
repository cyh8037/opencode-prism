import { log } from "./log"

// Wrap a plugin hook so a thrown error is logged to the file and swallowed.
// opencode publishes a throwing plugin hook as Session.Event.Error, which the
// TUI renders as an error in the conversation — internal plugin failures must
// never reach that path. The wrapped hook keeps the same signature.
export function guardHook<T extends (...args: never[]) => unknown>(name: string, hook: T): T {
  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    try {
      return await (hook as unknown as (...a: unknown[]) => unknown)(...args)
    } catch (error) {
      log(`[prism] hook "${name}" failed (swallowed)`, { error })
    }
  }
  return wrapped as unknown as T
}
