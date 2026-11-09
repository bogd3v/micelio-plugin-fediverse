/** Polls `predicate` (sync or async) until it returns a truthy value, then returns that value. */
async function waitUntil<T>(
  predicate: () => T | Promise<T>,
  { timeoutMs = 5000, intervalMs = 25 } = {}
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export { waitUntil }
