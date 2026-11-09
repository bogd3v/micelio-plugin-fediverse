import { createHash } from 'crypto'
import http from 'http'
import type { AddressInfo } from 'net'
import { generateCryptoKeyPair, signRequest } from '@fedify/fedify'
import { Person, CryptographicKey, Image } from '@fedify/fedify/vocab'
import type { ActivityJson } from './api-types'

const ACTIVITY_JSON = 'application/activity+json'

/**
 * Spins up a minimal HTTP server that plays the "remote fediverse server"
 * role in tests: it serves an ActivityPub actor document with an embedded
 * public key — so our plugin's inbound HTTP-signature verification and
 * `ctx.lookupObject()` calls have something real to dereference — and it
 * records any activity POSTed to its inbox (e.g. the signed `Accept` our
 * plugin sends back for a `Follow`). It also serves the documents a test
 * registers with `serve()` (the notes of a thread) and can leave a path hanging.
 */
interface RemoteActorOptions {
  preferredUsername?: string
  name?: string
  iconUrl?: string
  /**
   * The icon's `url` exactly as the remote server would write it, unparsed, so a
   * test can send a value `new URL()` would reject (a relative path). Wins over `iconUrl`.
   */
  rawIconUrl?: string
  /**
   * Makes the first `times` POSTs to the inbox answer `status` (with a body, as a
   * real server's error page would) instead of accepting them; they are counted in
   * `inboxAttempts` but not recorded as deliveries. `times: Infinity` never accepts.
   * Fedify "double-knocks" a server that refuses a delivery, sending it again with
   * the other HTTP signature spec in the same attempt, so a failed attempt costs two POSTs.
   */
  inboxFailures?: { status: number; times: number; body?: string }
}

/** RFC 3230 algorithm names a test may put in the `Digest` header, mapped to `node:crypto` hashes. */
const DIGEST_HASHES = { SHA: 'sha1', 'SHA-256': 'sha256', 'SHA-512': 'sha512' } as const

type DigestAlgorithm = keyof typeof DIGEST_HASHES

interface SignOptions {
  /**
   * Algorithms of the `Digest` header, in order, each with the correct digest of
   * the body. Unset, `signRequest` adds `SHA-256` as a real server would.
   */
  digest?: readonly DigestAlgorithm[]
  /**
   * Signs with RFC 9421 (`Signature-Input`, `Content-Digest`) instead of
   * draft-cavage. Fedify's signer covers `content-digest` whenever there is a
   * body; `coverContentDigest: false` signs without it and then adds a correct
   * but unsigned `Content-Digest`, as a captured delivery replayed with a new
   * body would carry.
   */
  rfc9421?: { coverContentDigest?: boolean }
}

/** An RFC 9421 `Content-Digest` header (`sha-256=:…:`) of `body`. */
function contentDigestHeader(body: string): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`
}

/** A `Digest` header (`SHA=…, SHA-256=…`) with the correct value of each algorithm for `body`. */
function digestHeader(body: string, algorithms: readonly DigestAlgorithm[]): string {
  return algorithms
    .map((name) => `${name}=${createHash(DIGEST_HASHES[name]).update(body).digest('base64')}`)
    .join(', ')
}

async function createRemoteActor({
  preferredUsername = 'remote-test',
  name,
  iconUrl,
  rawIconUrl,
  inboxFailures,
}: RemoteActorOptions = {}) {
  const keyPair = await generateCryptoKeyPair()
  // Parsed JSON bodies, as remote servers would receive them.
  const inboxDeliveries: ActivityJson[] = []
  // The same deliveries as received, so a test can verify their HTTP signatures.
  const inboxRequests: { headers: Headers; body: string }[] = []
  // Every POST to the inbox, accepted or not.
  let inboxAttempts = 0
  // Documents served at other paths (notes of a thread), and paths that never answer.
  const documents = new Map<string, unknown>()
  const hangingPaths = new Set<string>()
  // The path of every GET the server received, in order.
  const getRequests: string[] = []

  const server = http.createServer((req, res) => {
    if (req.method === 'GET') getRequests.push(req.url ?? '')
    if (req.method === 'GET' && hangingPaths.has(req.url ?? '')) return
    if (req.method === 'GET' && documents.has(req.url ?? '')) {
      res.writeHead(200, { 'content-type': ACTIVITY_JSON })
      res.end(JSON.stringify(documents.get(req.url ?? '')))
      return
    }
    if (req.method === 'GET' && req.url === '/actor') {
      void (async () => {
        try {
          const doc = await buildActorDocument()
          res.writeHead(200, { 'content-type': ACTIVITY_JSON })
          res.end(JSON.stringify(doc))
        } catch (error) {
          res.writeHead(500)
          res.end(String(error))
        }
      })()
      return
    }

    if (req.method === 'POST' && req.url === '/inbox') {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        inboxAttempts += 1
        if (inboxFailures && inboxAttempts <= inboxFailures.times) {
          res.writeHead(inboxFailures.status)
          res.end(inboxFailures.body ?? '')
          return
        }
        const body = Buffer.concat(chunks).toString('utf8')
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name, value)
        }
        inboxRequests.push({ headers, body })
        try {
          inboxDeliveries.push(JSON.parse(body))
        } catch {
          // Malformed body: nothing to record, still ack the delivery below.
        }
        res.writeHead(202)
        res.end()
      })
      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const actorUrl = `http://127.0.0.1:${port}/actor`
  const inboxUrl = `http://127.0.0.1:${port}/inbox`
  const keyId = new URL(`${actorUrl}#main-key`)

  async function buildActorDocument() {
    const key = new CryptographicKey({
      id: keyId,
      owner: new URL(actorUrl),
      publicKey: keyPair.publicKey,
    })
    const person = new Person({
      id: new URL(actorUrl),
      preferredUsername,
      name,
      icon: iconUrl ? new Image({ url: new URL(iconUrl) }) : undefined,
      inbox: new URL(inboxUrl),
      publicKey: key,
    })
    const doc = (await person.toJsonLd({ format: 'compact' })) as Record<string, unknown>
    return rawIconUrl === undefined ? doc : { ...doc, icon: { type: 'Image', url: rawIconUrl } }
  }

  async function signActivity(
    url: string,
    activity: unknown,
    { digest, rfc9421 }: SignOptions = {}
  ): Promise<Request> {
    const body = JSON.stringify(activity)
    const headers: Record<string, string> = { 'content-type': ACTIVITY_JSON }
    // `signRequest` signs a `Digest` already set and adds `SHA-256` only when there is none.
    if (digest) headers.digest = digestHeader(body, digest)
    const request = new Request(url, { method: 'POST', headers, body })
    if (!rfc9421) return signRequest(request, keyPair.privateKey, keyId)
    if (rfc9421.coverContentDigest !== false) {
      return signRequest(request, keyPair.privateKey, keyId, { spec: 'rfc9421' })
    }
    // With `body: null` the signer sees no body, so it neither adds nor covers `content-digest`.
    const signed = await signRequest(request, keyPair.privateKey, keyId, {
      spec: 'rfc9421',
      body: null,
    })
    const unsignedHeaders = new Headers(signed.headers)
    unsignedHeaders.set('content-digest', contentDigestHeader(body))
    return new Request(url, { method: 'POST', headers: unsignedHeaders, body })
  }

  return {
    actorUrl,
    inboxUrl,
    keyId,
    inboxDeliveries,
    inboxRequests,
    getRequests,
    /** Serves `document` as ActivityPub JSON at `path` (from `/`) and returns its URL. */
    serve(path: string, document: unknown): string {
      documents.set(path, document)
      return `http://127.0.0.1:${port}${path}`
    },
    /** Makes GETs of `path` never answer, as a stalled server would, and returns its URL. */
    hang(path: string): string {
      hangingPaths.add(path)
      return `http://127.0.0.1:${port}${path}`
    },
    /** How many POSTs the inbox has received, including the ones `inboxFailures` refused. */
    get inboxAttempts() {
      return inboxAttempts
    },
    /** Builds an HTTP-signed POST of `activity` to `url` as this remote actor, without sending it. */
    signActivity,
    /** Builds and HTTP-signs a POST of `activity` to `url` as this remote actor. */
    async postSignedActivity(url: string, activity: unknown, options?: SignOptions) {
      return fetch(await signActivity(url, activity, options))
    },
    async close() {
      // A request left hanging would keep `close()` waiting forever.
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    },
  }
}

/** A running fake remote server, as `createRemoteActor` returns it. */
type RemoteActor = Awaited<ReturnType<typeof createRemoteActor>>

export { createRemoteActor, type RemoteActor }
