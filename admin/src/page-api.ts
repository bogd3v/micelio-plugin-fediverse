import { useFetchClient } from '@strapi/strapi/admin'
import { useCallback, useEffect, useRef, useState } from 'react'

import { interpretPostResponse, interpretResponse } from './state'

/** Prefix of the admin routes of the plugin; not `/fediverse`, which Fedify's middleware owns. */
const ROUTE_PREFIX = '/fediverse-panel'

/** Ask for the body as text and take every status: see `interpretResponse` for why. */
const AS_TEXT = { responseType: 'text', validateStatus: () => true } as const

/** What a section of the page can be showing. */
export type Resource<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error' }

/** A refused action: the problem `code` the route answered, if it gave one. */
export class ActionRefused extends Error {
  constructor(readonly code: string | undefined) {
    super(code ?? 'refused')
    this.name = 'ActionRefused'
  }
}

/** Loads a section of the page, and loads it again on `reload()`. */
export function useResource<T>(path: string): { resource: Resource<T>; reload: () => void } {
  // The client is rebuilt on every render; the effect must not depend on it.
  const client = useFetchClient()
  const clientRef = useRef(client)
  clientRef.current = client
  const [resource, setResource] = useState<Resource<T>>({ kind: 'loading' })
  const [count, setCount] = useState(0)

  useEffect(() => {
    let current = true
    void (async () => {
      try {
        const response = await clientRef.current.get<string>(`${ROUTE_PREFIX}${path}`, AS_TEXT)
        const result = interpretResponse<T>(response.status ?? 0, response.data)
        if (current)
          setResource(result.ok ? { kind: 'ready', data: result.data } : { kind: 'error' })
      } catch {
        // Network failure: the request never got an answer.
        if (current) setResource({ kind: 'error' })
      }
    })()
    return () => {
      current = false
    }
  }, [path, count])

  const reload = useCallback(() => {
    setResource({ kind: 'loading' })
    setCount((value) => value + 1)
  }, [])
  return { resource, reload }
}

/** Sends a `POST` to a route of the plugin; resolves the answer or throws `ActionRefused`. */
export function usePost(): <T>(path: string) => Promise<T> {
  const client = useFetchClient()
  const clientRef = useRef(client)
  clientRef.current = client
  return useCallback(async <T>(path: string): Promise<T> => {
    try {
      const response = await clientRef.current.post<unknown>(
        `${ROUTE_PREFIX}${path}`,
        {},
        {
          validateStatus: () => true,
        }
      )
      const result = interpretPostResponse<T>(response.data)
      if (!result.ok) throw new ActionRefused(result.problem?.code)
      return result.data
    } catch (error) {
      // A body that is not JSON, or no answer at all: refused with no code to explain.
      throw error instanceof ActionRefused ? error : new ActionRefused(undefined)
    }
  }, [])
}
