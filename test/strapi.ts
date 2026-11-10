import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { Core } from '@strapi/strapi'

// Strapi is loaded as CommonJS, as a host loads it: its ESM build imports lodash's named exports,
// which Node's ESM loader cannot resolve.
const { createStrapi } = createRequire(import.meta.url)(
  '@strapi/strapi'
) as typeof import('@strapi/strapi')

/** The clean Strapi the suites boot (`test/app/`), with only this plugin installed. */
const APP_DIR = fileURLToPath(new URL('app', import.meta.url))

declare global {
  // Strapi's global, set by `createStrapi` (`instance.load()`).
  var strapi: Core.Strapi
}

// One SQLite file per Vitest worker: suites run in parallel workers and each one
// deletes/recreates its database, so a shared file makes them clobber each other.
// config/database.ts resolves DATABASE_FILENAME relative to the project root, so
// the env var must stay relative or the real file lands somewhere this harness
// never cleans up (stale rows then leak between runs).
const TEST_DB_RELATIVE_PATH = path.join('.tmp', `test-${process.env.VITEST_POOL_ID || '1'}.db`)
const TEST_DB_PATH = path.join(APP_DIR, TEST_DB_RELATIVE_PATH)

// Set TEST_DATABASE_URL (e.g. postgres://user:pass@127.0.0.1:5432/postgres) to run
// the suites against PostgreSQL, which is what production uses, instead of SQLite.
// Each Vitest worker gets its own database (strapi_test_<worker>) inside that server.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''

function postgresTarget() {
  const url = new URL(TEST_DATABASE_URL)
  const database = `strapi_test_${process.env.VITEST_POOL_ID || '1'}`
  return {
    admin: TEST_DATABASE_URL,
    database,
    host: url.hostname,
    port: url.port || '5432',
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    url: `${url.protocol}//${url.username}:${url.password}@${url.host}/${database}`,
  }
}

/** Recreates this worker's database so every run starts from an empty schema. */
async function resetPostgresDatabase() {
  const target = postgresTarget()
  const admin = new pg.Client({ connectionString: target.admin })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${target.database}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${target.database}"`)
  } finally {
    await admin.end()
  }
}

function setupEnvironment() {
  process.env.NODE_ENV = 'test'
  process.env.PORT = process.env.PORT || '0'
  // Telemetry is off through test/app/package.json (`telemetryDisabled`).
  delete process.env.STRAPI_TELEMETRY_DISABLED
  process.env.STRAPI_DISABLE_CRON = 'true'

  // Required Strapi security values (dummy values are fine for tests)
  process.env.APP_KEYS = process.env.APP_KEYS || 'testKeyOne,testKeyTwo'
  process.env.API_TOKEN_SALT = process.env.API_TOKEN_SALT || 'test-api-token-salt'
  process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-jwt-secret'
  process.env.TRANSFER_TOKEN_SALT = process.env.TRANSFER_TOKEN_SALT || 'test-transfer-token-salt'
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret'
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef'

  if (TEST_DATABASE_URL) {
    const target = postgresTarget()
    process.env.DATABASE_CLIENT = 'postgres'
    process.env.DATABASE_URL = target.url
    process.env.DATABASE_HOST = target.host
    process.env.DATABASE_PORT = target.port
    process.env.DATABASE_NAME = target.database
    process.env.DATABASE_USERNAME = target.username
    process.env.DATABASE_PASSWORD = target.password
    process.env.DATABASE_SSL = 'false'
    return
  }

  // Use an isolated SQLite database for tests
  process.env.DATABASE_CLIENT = 'sqlite'
  process.env.DATABASE_FILENAME = TEST_DB_RELATIVE_PATH
}

let instance: Core.Strapi | undefined

/**
 * Boots Strapi on an empty database.
 *
 * @param options.keepDatabase - Boots on the database a previous `cleanupStrapi()` left, to
 * test a restart. On SQLite the previous `cleanupStrapi({ keepDatabase: true })` must have kept the
 * file; a plain `cleanupStrapi()` deletes it.
 * @param options.editorialArticle - Boots with `api::article.article` made with `withEditorial` of the
 * core (test/app/src/api/article/content-types/article/schema.js), as a host that moved it to the
 * editorial workflow. Unset, the article keeps the schema of its `base.json`.
 */
async function setupStrapi({
  keepDatabase = false,
  editorialArticle = false,
}: { keepDatabase?: boolean; editorialArticle?: boolean } = {}) {
  if (instance) {
    return instance
  }

  setupEnvironment()
  process.env.FEDIVERSE_TEST_EDITORIAL_ARTICLE = editorialArticle ? 'true' : 'false'

  // Start from an empty database
  if (keepDatabase) {
    if (!TEST_DATABASE_URL && !fs.existsSync(TEST_DB_PATH)) {
      throw new Error(
        'keepDatabase needs TEST_DATABASE_URL or a SQLite file kept by cleanupStrapi({ keepDatabase: true })'
      )
    }
  } else if (TEST_DATABASE_URL) {
    await resetPostgresDatabase()
  } else if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH)
  }

  // The local upload provider refuses to start without its folder, as in a new Strapi project.
  fs.mkdirSync(path.join(APP_DIR, 'public', 'uploads'), { recursive: true })
  // `test/global-setup.ts` built the plugin into dist/ before any suite ran.
  instance = createStrapi({ appDir: APP_DIR, distDir: APP_DIR })
  await instance.load()
  await instance.start()

  // Reduce noise in test output
  instance.log.level = 'error'

  return instance
}

// A write that succeeds can leave work queued behind it (publish listeners, lifecycle hooks)
// that still waits for a connection. Destroying the pool rejects those waiters with
// `Error: aborted` as an unhandled rejection, which kills the Vitest process before it prints
// a summary. A test that expected the write to fail hits exactly that path, so cleanup waits
// for the pool to go quiet first.
const POOL_IDLE_TIMEOUT_MS = 5000
const POOL_IDLE_POLL_MS = 10

interface PoolStats {
  numUsed(): number
  numPendingAcquires(): number
  numPendingCreates(): number
}

/** Resolves once no query is running or waiting for a connection, or after the timeout. */
async function waitForPoolIdle(connection: unknown): Promise<void> {
  const pool = (connection as { client?: { pool?: PoolStats } } | undefined)?.client?.pool
  if (!pool) {
    return
  }

  const deadline = Date.now() + POOL_IDLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (pool.numUsed() + pool.numPendingAcquires() + pool.numPendingCreates() === 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, POOL_IDLE_POLL_MS))
  }
}

/**
 * Stops the running Strapi.
 *
 * @param options.keepDatabase - Leaves the SQLite file for a `setupStrapi({ keepDatabase: true })`.
 */
async function cleanupStrapi({ keepDatabase = false }: { keepDatabase?: boolean } = {}) {
  if (!instance) {
    return
  }

  await instance.server.httpServer.close()

  const dbConnection = instance.db?.connection
  await waitForPoolIdle(dbConnection)
  if (dbConnection?.destroy) {
    await dbConnection.destroy()
  }

  await instance.destroy()
  instance = undefined

  if (!keepDatabase && !TEST_DATABASE_URL && fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH)
  }
}

/** `127.0.0.1:<port>` of the running test server, as remote servers reach it. */
function serverHost(): string {
  const { port } = strapi.server.httpServer.address() as AddressInfo
  return `127.0.0.1:${port}`
}

export { setupStrapi, cleanupStrapi, serverHost }
