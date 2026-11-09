/**
 * Shapes of the JSON the suites read from responses. Supertest types every
 * body as `any`; these name the fields a test relies on, nothing more.
 */

/** A comment as strapi-plugin-comments returns it, with our fediverse fields. */
export interface ApiComment {
  id: number
  content: string
  blocked?: boolean
  approvalStatus?: string
  author?: Record<string, unknown> | null
  fediverseUri?: string | null
  fediverseActorHandle?: string | null
  children?: ApiComment[]
}

/**
 * An ActivityPub object or activity as JSON-LD (actor, Article, collection,
 * Create...). Only the fields the suites read are named; JSON-LD allows a
 * value or an array for most of them.
 */
export interface ActivityJson {
  id?: string
  type?: string
  actor?: string
  object?: ActivityJson
  name?: string
  summary?: string
  content?: string
  url?: string
  attributedTo?: string
  to?: string | string[]
  cc?: string | string[]
  published?: string
  updated?: string
  image?: { url: string; mediaType?: string; name?: string }
  outbox?: string
  totalItems?: number
  orderedItems?: ActivityJson | ActivityJson[]
  [field: string]: unknown
}
