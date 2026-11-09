/** Limits of reply ingestion. */

/**
 * Most parent notes fetched for one delivered reply whose `inReplyTo` matches
 * nothing stored. A chain that has not reached our conversation by then is dropped.
 */
export const MAX_THREAD_DEPTH = 5

/**
 * Milliseconds one inbox delivery may spend fetching the notes above a reply and
 * their authors. Inbox listeners run while the remote server waits for the answer,
 * so a slow server cannot hold the inbox longer than this. See `docs/FEDIVERSE.md`.
 */
export const THREAD_TIME_BUDGET_MS = 5_000
