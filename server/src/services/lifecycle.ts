import type { Core } from '@strapi/strapi'

import { ARTICLE_UID } from '../constants/uids'
import type { TrackedLifecycleEvent } from '../types/lifecycle'

interface EntryEvent {
  model?: string
  uid?: string
  entry?: { documentId?: string } | null
}

const PUBLISH_EVENT = 'entry.publish'
const UNPUBLISH_EVENT = 'entry.unpublish'

// Strapi 5 does not emit publish lifecycles through `strapi.db.lifecycles`
// (publish maps to afterCreate, unpublish to afterDelete there). The document
// service emits `entry.publish` / `entry.unpublish` on `strapi.eventHub`
// after the DB transaction commits, with the sanitized entry as payload.
const events: TrackedLifecycleEvent[] = []
let unsubscribers: Array<() => void> = []

/**
 * Records article publish events so tests can verify `strapi.eventHub`
 * delivers them. The actual federation lives in `services/publisher.ts`.
 */
export function subscribe(strapi: Core.Strapi): void {
  const track =
    (action: string) =>
    async (payload: EntryEvent): Promise<void> => {
      if (payload?.uid !== ARTICLE_UID) return

      const tracked: TrackedLifecycleEvent = {
        action,
        uid: payload.uid,
        documentId: payload.entry?.documentId,
        recordedAt: new Date().toISOString(),
      }
      events.push(tracked)

      strapi.log.info(
        `[fediverse] lifecycle ${tracked.action} — article ${tracked.documentId ?? '(no documentId)'}`
      )
    }

  unsubscribers = [
    strapi.eventHub.on(PUBLISH_EVENT, track(PUBLISH_EVENT)),
    strapi.eventHub.on(UNPUBLISH_EVENT, track(UNPUBLISH_EVENT)),
  ]
}

/** Stops recording; called by the plugin's `destroy()`. */
export function unsubscribe(): void {
  for (const off of unsubscribers) off()
  unsubscribers = []
}

/** A copy of the events recorded since boot or the last `clear`. */
export function getEvents(): TrackedLifecycleEvent[] {
  return [...events]
}

/** Forgets the recorded events. */
export function clear(): void {
  events.length = 0
}

export default (): {
  getEvents: typeof getEvents
  clear: typeof clear
  unsubscribe: typeof unsubscribe
} => ({
  getEvents,
  clear,
  unsubscribe,
})
