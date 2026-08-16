// Reset shared module state between tests. Prism modules use factory/class
// construction (no global mutable singletons) so nothing needs resetting
// today; this file exists as the single place to add resets if that changes.
import { afterEach } from "bun:test"

afterEach(() => {
  // reserved for future module-level state resets
})
