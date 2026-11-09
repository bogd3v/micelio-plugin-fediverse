/** Settings of the key-value store and the delivery queue Fedify uses. */

/**
 * Connections of the pool Fedify opens on PostgreSQL, apart from Strapi's own.
 *
 * @remarks
 * The queue also holds one dedicated connection to `LISTEN` for new messages, so
 * federation adds at most `FEDIFY_POOL_SIZE + 1` connections per Strapi process.
 * See `docs/operate/configure.md`.
 */
export const FEDIFY_POOL_SIZE = 3

/** Seconds a closing Fedify pool waits for running queries before dropping its connections. */
export const FEDIFY_POOL_CLOSE_TIMEOUT_SECONDS = 5

/** Milliseconds `destroy()` waits for the queue worker to stop before it closes the pool anyway. */
export const QUEUE_STOP_TIMEOUT_MS = 10_000
