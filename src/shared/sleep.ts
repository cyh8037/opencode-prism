// Promise-based delay shared across modules that poll or back off (prompt
// gate, vision interpreter, JSON prompt sessions).
export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
