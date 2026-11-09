import type { Core } from '@strapi/strapi'

import { InProcessMessageQueue, MemoryKvStore } from '@fedify/fedify'
import { PostgresKvStore, PostgresMessageQueue } from '@fedify/postgres'
import postgres, { type Options, type PostgresType } from 'postgres'

import type { FederationBackend } from '../types/federation'
import { FEDIFY_POOL_CLOSE_TIMEOUT_SECONDS, FEDIFY_POOL_SIZE } from '../constants/queue'

/** The part of Strapi's `database.connection` setting this module reads. */
interface DatabaseSetting {
  client?: string
  connection?: {
    connectionString?: string
    host?: string
    port?: number
    database?: string
    user?: string
    password?: string
    ssl?: boolean | Record<string, unknown>
    schema?: string
  }
}

const POSTGRES_CLIENTS = ['postgres', 'pg']

/** Drops the options Strapi leaves `undefined`, which `postgres` would read as set. */
function defined<T extends Record<string, unknown>>(options: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

/**
 * The TLS setting a `sslmode` in the connection string asks for, read the way `pg`
 * (Strapi's driver) reads it: `require`, `prefer`, `verify-ca` and `verify-full` verify the
 * server's certificate, `no-verify` does not, `disable` and no `sslmode` ask for nothing.
 * The `postgres` driver reads `require` as "encrypt without verifying", so the pool must
 * be told explicitly or it would be weaker than Strapi's own connection.
 */
function sslModeOf(
  connectionString: string | undefined
): Options<Record<string, PostgresType>>['ssl'] {
  let mode: string | null = null
  try {
    mode = connectionString ? new URL(connectionString).searchParams.get('sslmode') : null
  } catch {
    return undefined
  }
  if (mode === 'no-verify') return { rejectUnauthorized: false }
  if (mode === 'require' || mode === 'prefer' || mode === 'verify-ca' || mode === 'verify-full') {
    return { rejectUnauthorized: true }
  }
  return undefined
}

/**
 * The options of the Fedify pool.
 *
 * @internal Exported for tests.
 */
export function postgresOptions(
  connection: NonNullable<DatabaseSetting['connection']>
): Options<Record<string, PostgresType>> {
  const { ssl } = connection
  const fromUrl = sslModeOf(connection.connectionString)
  return {
    max: FEDIFY_POOL_SIZE,
    // `CREATE TABLE IF NOT EXISTS` answers with a notice that the driver would print to the console.
    onnotice: () => {},
    ...(connection.schema ? { connection: { search_path: connection.schema } } : {}),
    ...(ssl && typeof ssl === 'object'
      ? {
          ssl: defined({
            rejectUnauthorized: ssl.rejectUnauthorized,
            ca: ssl.ca,
            cert: ssl.cert,
            key: ssl.key,
          }),
        }
      : ssl === true
        ? { ssl: true }
        : fromUrl
          ? { ssl: fromUrl }
          : {}),
  }
}

/**
 * Chooses where Fedify's key-value store and delivery queue live, from the
 * database Strapi is configured with.
 *
 * @remarks
 * On PostgreSQL both go into that database, through one small dedicated pool
 * (`FEDIFY_POOL_SIZE` connections, plus one the queue holds to listen for new
 * messages), so federation never takes connections from Strapi's own pool and
 * a queued delivery survives a restart. On any other database, which means
 * development and tests, they are in memory. Nothing connects until the first
 * query. No variable selects the backend, so the operator interface is unchanged.
 */
export function createFederationBackend(strapi: Core.Strapi): FederationBackend {
  const setting = strapi.config.get('database.connection') as DatabaseSetting | undefined
  const connection = setting?.connection
  if (setting?.client == null || !POSTGRES_CLIENTS.includes(setting.client) || connection == null) {
    return {
      kind: 'memory',
      kv: new MemoryKvStore(),
      queue: new InProcessMessageQueue(),
      close: async () => {},
    }
  }

  const options = postgresOptions(connection)
  const sql = connection.connectionString
    ? postgres(connection.connectionString, options)
    : postgres({
        ...options,
        ...defined({
          host: connection.host,
          port: connection.port,
          database: connection.database,
          username: connection.user,
          password: connection.password,
        }),
      })
  let closing: Promise<void> | undefined
  return {
    kind: 'postgres',
    kv: new PostgresKvStore(sql),
    queue: new PostgresMessageQueue(sql),
    close: () => {
      closing ??= sql.end({ timeout: FEDIFY_POOL_CLOSE_TIMEOUT_SECONDS })
      return closing
    },
  }
}
