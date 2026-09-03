// Promise-based delay shared across modules that poll or back off (prompt
// gate, vision interpreter, JSON prompt sessions).
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      resolve()
    }
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
    }
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
  })
}
