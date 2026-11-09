/**
 * Settles as `work` does, or rejects with the signal's reason as soon as
 * `signal` aborts, whichever comes first.
 *
 * @remarks
 * For calls that take no `AbortSignal` of their own (Fedify's `getActorHandle`).
 * The work itself is not cancelled: it runs on until its own timeout, but nobody waits for it.
 */
export async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort = (): void => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
