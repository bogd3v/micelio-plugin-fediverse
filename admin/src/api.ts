import { useFetchClient } from '@strapi/strapi/admin'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  classifyFailure,
  interpretPostResponse,
  interpretResponse,
  type ArticleFederation,
  type FederateResult,
} from './state'

/** Prefix of the panel's admin routes; not `/fediverse`, which Fedify's middleware owns. */
const ROUTE_PREFIX = '/fediverse-panel/articles'

/** What the panel can be showing. */
export type PanelData =
  | { kind: 'loading' }
  | { kind: 'ready'; federation: ArticleFederation }
  | { kind: 'off' }
  | { kind: 'hidden' }
  | { kind: 'error' }

/** A refused "Federate now": the problem `code` the route answered, if it gave one. */
export class FederateRefused extends Error {
  constructor(readonly code: string | undefined) {
    super(code ?? 'refused')
    this.name = 'FederateRefused'
  }
}

/** Ask for the body as text and take every status: see `interpretResponse` for why. */
const AS_TEXT = { responseType: 'text', validateStatus: () => true } as const

/** What `useArticleFederation` gives the panel. */
export interface ArticleFederationHook {
  data: PanelData
  /** Loads the state again. */
  refresh: () => void
  /** Queues the article; resolves the result, or throws `FederateRefused`. */
  federate: () => Promise<FederateResult>
  /** Shows the loading message and loads the state again. */
  retry: () => void
}

/**
 * Loads the federation state of an article and sends "Federate now".
 *
 * @param documentId - Empty when the edit view is not an article's: nothing is requested.
 * @param refreshKey - Changes when the article was saved or published, to load the state again.
 */
export function useArticleFederation(
  documentId: string,
  locale: string,
  refreshKey: string
): ArticleFederationHook {
  // The client is rebuilt on every render; the effect and the callback must not depend on it.
  const client = useFetchClient()
  const clientRef = useRef(client)
  clientRef.current = client
  const [data, setData] = useState<PanelData>({ kind: 'loading' })
  const [reload, setReload] = useState(0)

  // A different article or language must not show the previous one's state while it loads.
  useEffect(() => {
    setData({ kind: 'loading' })
  }, [documentId, locale])

  useEffect(() => {
    if (documentId === '') return undefined
    let current = true
    void (async () => {
      try {
        const response = await clientRef.current.get<string>(
          `${ROUTE_PREFIX}/${documentId}/federation`,
          { params: { locale }, ...AS_TEXT }
        )
        const result = interpretResponse<ArticleFederation>(response.status ?? 0, response.data)
        if (!current) return
        setData(
          result.ok
            ? { kind: 'ready', federation: result.data }
            : { kind: classifyFailure(result.problem, result.status) }
        )
      } catch {
        // Network failure: the request never got an answer.
        if (current) setData({ kind: 'error' })
      }
    })()
    return () => {
      current = false
    }
  }, [documentId, locale, refreshKey, reload])

  const refresh = useCallback(() => setReload((count) => count + 1), [])

  const federate = useCallback(async (): Promise<FederateResult> => {
    try {
      const response = await clientRef.current.post<unknown>(
        `${ROUTE_PREFIX}/${documentId}/federate`,
        {},
        { params: { locale }, validateStatus: () => true }
      )
      const result = interpretPostResponse<FederateResult>(response.data)
      if (!result.ok) throw new FederateRefused(result.problem?.code)
      return result.data
    } catch (error) {
      // A body that is not JSON, or no answer at all: refused with no code to explain.
      throw error instanceof FederateRefused ? error : new FederateRefused(undefined)
    } finally {
      refresh()
    }
  }, [documentId, locale, refresh])

  const retry = useCallback(() => {
    setData({ kind: 'loading' })
    refresh()
  }, [refresh])

  return { data, refresh, federate, retry }
}
