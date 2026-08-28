import { describe, expect, test } from "bun:test"
import { ConcurrencyManager } from "../src/core/background/concurrency"

describe("ConcurrencyManager invariant (R8)", () => {
  test("finite positive limits are accepted", () => {
    expect(() => new ConcurrencyManager(1)).not.toThrow()
    expect(() => new ConcurrencyManager(5)).not.toThrow()
  })

  test("non-finite or non-positive limits throw at construction", () => {
    expect(() => new ConcurrencyManager(Infinity)).toThrow()
    expect(() => new ConcurrencyManager(NaN)).toThrow()
    expect(() => new ConcurrencyManager(0)).toThrow()
    expect(() => new ConcurrencyManager(-1)).toThrow()
  })
})

describe("ConcurrencyManager snapshot", () => {
  test("empty snapshot when nothing acquired or queued", () => {
    const concurrency = new ConcurrencyManager(2)
    expect(concurrency.snapshot()).toEqual([])
  })

  test("active counts reflect acquired slots", async () => {
    const concurrency = new ConcurrencyManager(2)
    await concurrency.acquire("k1")
    await concurrency.acquire("k1")
    const rows = concurrency.snapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ key: "k1", active: 2, limit: 2 })
  })

  test("queued waiters keep their key visible in the snapshot", async () => {
    const concurrency = new ConcurrencyManager(1)
    await concurrency.acquire("k1")
    const wait = concurrency.acquire("k1") // 排队中,未 acquire
    const rows = concurrency.snapshot()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.active).toBe(1)
    expect(rows[0]!.limit).toBe(1)
    concurrency.release("k1")
    await wait
  })

  test("release to zero hides the group from the snapshot (header shows only active groups)", async () => {
    const concurrency = new ConcurrencyManager(2)
    await concurrency.acquire("k1")
    concurrency.release("k1")
    expect(concurrency.snapshot()).toEqual([])
  })

  test("rows are sorted by key", async () => {
    const concurrency = new ConcurrencyManager(2)
    await concurrency.acquire("zebra")
    await concurrency.acquire("alpha")
    expect(concurrency.snapshot().map((row) => row.key)).toEqual(["alpha", "zebra"])
  })

  test("clear empties the snapshot", async () => {
    const concurrency = new ConcurrencyManager(2)
    await concurrency.acquire("k1")
    concurrency.clear()
    expect(concurrency.snapshot()).toEqual([])
  })
})
