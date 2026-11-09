import type { Core } from '@strapi/strapi'

import { getFederationBackendKind, getFederationKv } from '../federation'
import type { Diagnostic, DiagnosticFailure } from '../types/plugin-page'
import { ActorKeyDecryptionError } from '../utils/key-encryption'
import { webFingerSubject } from '../utils/handle-host'
import { publicOrigin } from '../utils/public-origin'
import { countFollowers } from './followers'
import { getActorUsername } from './actor-profile'
import { countInboxRefusals } from './inbox-refusals'
import { verifyStoredActorKey } from './keys'

/** Largest WebFinger answer the self-check parses; the real one is a few hundred bytes. */
const WEBFINGER_MAX_BYTES = 64 * 1024

/** How long the WebFinger self-check waits for the CMS's own public address. */
const WEBFINGER_TIMEOUT_MS = 5000

const ok = (id: Diagnostic['id'], value: Diagnostic['value'] = null): Diagnostic => ({
  id,
  ok: true,
  code: null,
  value,
})
const failed = (id: Diagnostic['id'], code: DiagnosticFailure): Diagnostic => ({
  id,
  ok: false,
  code,
  value: null,
})

function checkPublicUrl(origin: string | undefined): Diagnostic {
  if (origin == null) return failed('public-url', 'url-missing')
  return origin.startsWith('https://')
    ? ok('public-url', origin)
    : failed('public-url', 'url-not-https')
}

/**
 * Checks the stored actor key without changing anything: a read route must not create the actor's
 * identity or rewrite its key. Only the error's class decides the code, never its message.
 */
async function checkActorKey(strapi: Core.Strapi): Promise<Diagnostic> {
  try {
    return (await verifyStoredActorKey(strapi)) === 'ok'
      ? ok('actor-key')
      : failed('actor-key', 'actor-key-missing')
  } catch (error) {
    return failed(
      'actor-key',
      error instanceof ActorKeyDecryptionError
        ? 'actor-key-missing-encryption-key'
        : 'actor-key-unreadable'
    )
  }
}

/**
 * Asks the CMS's own public address for the actor's WebFinger document, as a remote server
 * would. The only request the plugin makes to its own origin; the address is the operator's
 * `URL`, never one a visitor gave.
 */
async function checkWebFinger(
  strapi: Core.Strapi,
  origin: string | undefined
): Promise<Diagnostic> {
  if (origin == null) return failed('webfinger', 'webfinger-skipped')
  const subject = webFingerSubject(await getActorUsername(strapi), origin)
  let response: Response
  try {
    response = await fetch(
      `${origin}/.well-known/webfinger?resource=${encodeURIComponent(subject)}`,
      {
        headers: { accept: 'application/jrd+json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBFINGER_TIMEOUT_MS),
      }
    )
  } catch {
    return failed('webfinger', 'webfinger-unreachable')
  }
  if (response.status !== 200) {
    // Free the socket: the body of an error page is not read.
    await response.body?.cancel()
    return failed('webfinger', 'webfinger-not-found')
  }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (!/json/i.test(response.headers.get('content-type') ?? '') || length > WEBFINGER_MAX_BYTES) {
    await response.body?.cancel()
    return failed('webfinger', 'webfinger-wrong-subject')
  }
  try {
    const body = (await response.json()) as { subject?: unknown }
    return body.subject === subject
      ? ok('webfinger')
      : failed('webfinger', 'webfinger-wrong-subject')
  } catch {
    return failed('webfinger', 'webfinger-wrong-subject')
  }
}

/** A figure of the page, or `null` when reading it failed: one broken figure must not blank the page. */
async function figure(
  strapi: Core.Strapi,
  name: string,
  read: () => Promise<number>
): Promise<number | null> {
  try {
    return await read()
  } catch (error) {
    strapi.log.warn(
      `[fediverse] diagnostics could not read ${name}: ${error instanceof Error ? error.name : 'unknown error'}`
    )
    return null
  }
}

/**
 * Runs the checks of the plugin page, in the order it shows them. None throws: a check that
 * cannot run is a failing check with its own code.
 */
export async function runDiagnostics(strapi: Core.Strapi): Promise<Diagnostic[]> {
  const origin = publicOrigin()
  const [actorKey, webfinger, followers, refusals] = await Promise.all([
    checkActorKey(strapi),
    checkWebFinger(strapi, origin),
    figure(strapi, 'followers', () => countFollowers(strapi)),
    figure(strapi, 'inbox refusals', () => countInboxRefusals(getFederationKv(strapi))),
  ])
  return [
    checkPublicUrl(origin),
    actorKey,
    webfinger,
    { id: 'backend', ok: null, code: null, value: getFederationBackendKind(strapi) },
    { id: 'followers', ok: null, code: null, value: followers },
    { id: 'inbox-refusals', ok: null, code: null, value: refusals },
  ]
}
