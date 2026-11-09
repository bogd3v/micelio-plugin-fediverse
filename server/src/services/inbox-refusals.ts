import type { Core } from '@strapi/strapi'
import { Temporal } from '@js-temporal/polyfill'
import type { KvKey, KvStore } from '@fedify/fedify'

/** Key of the counter of refused inbox deliveries in one hour. */
const keyOf = (bucket: number): KvKey => ['micelio', 'fediverse', 'inboxRefusals', String(bucket)]
const HOUR_MS = 3_600_000
/** Hours the page counts, and (plus one) how long a bucket is kept. */
const WINDOW_HOURS = 24

const bucketOf = (at: number): number => Math.floor(at / HOUR_MS)

/**
 * Counts a delivery to the inbox that was refused (`401`), in the hour it happened.
 *
 * @remarks
 * The count lives in Fedify's key-value store, so on PostgreSQL it survives a restart and on
 * SQLite it does not. Read-then-write without a lock, so two refusals in the same instant can
 * count once: this is a figure for a person to read, not an audit log (`security:` events are).
 * Never throws, and callers do not wait for it: counting must not change or delay the answer to
 * the request. `getKv` is a function because the store is gone once federation is stopped.
 */
export async function recordInboxRefusal(
  getKv: () => KvStore,
  log: Pick<Core.Strapi['log'], 'warn'>,
  at = Date.now()
): Promise<void> {
  try {
    const kv = getKv()
    const key = keyOf(bucketOf(at))
    const current = Number((await kv.get<number>(key)) ?? 0)
    await kv.set(key, current + 1, {
      ttl: Temporal.Duration.from({ hours: WINDOW_HOURS + 1 }),
    })
  } catch (error) {
    log.warn(
      `[fediverse] could not count a refused inbox delivery: ${error instanceof Error ? error.name : 'unknown error'}`
    )
  }
}

/** Refused inbox deliveries in the last 24 hours (the current hour and the 23 before it). */
export async function countInboxRefusals(kv: KvStore, at = Date.now()): Promise<number> {
  const current = bucketOf(at)
  const counts = await Promise.all(
    Array.from({ length: WINDOW_HOURS }, (_, back) => kv.get<number>(keyOf(current - back)))
  )
  return counts.reduce<number>((sum, count) => sum + Number(count ?? 0), 0)
}
