/** Public profile of the blog's actor. */

/** A row of the profile metadata table, federated as a `PropertyValue` attachment. */
export interface ActorProfileField {
  name: string
  /** Absolute URL, rendered as a link in the profile metadata table. */
  url: string
}

/**
 * What the actor's `Person` document shows, and what `Update(Person)` refreshes
 * on followers' servers.
 */
export interface ActorProfile {
  /** The handle's `@user` (`preferredUsername`). */
  username: string
  name: string
  /** Plain text bio; null when no setting, variable or site description gives one. */
  summary: string | null
  /** Absolute URL to the actor avatar (global favicon), or null. */
  iconUrl: string | null
  /** Absolute URL to the profile header image (default site), or null. */
  headerUrl: string | null
  /** Whether the actor opts into Mastodon's public directory. */
  discoverable: boolean
  /** Human-facing page for the actor: the frontend home page. */
  url: string
  fields: ActorProfileField[]
  /** Domains whose pages Mastodon may credit the actor on, see `utils/attribution-domains.ts`; empty for none. */
  attributionDomains: string[]
}
