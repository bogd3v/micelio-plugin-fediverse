/** Publish/unpublish events recorded for diagnostics. */

/** An article publish or unpublish seen on `strapi.eventHub`. */
export interface TrackedLifecycleEvent {
  /** `entry.publish` or `entry.unpublish`. */
  action: string
  uid: string
  documentId: string | undefined
  /** ISO 8601 time the event was seen. */
  recordedAt: string
}
