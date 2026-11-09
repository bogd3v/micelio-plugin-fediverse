/** URI templates Fedify dispatches on. */

/** Path of the blog's actor document, an ActivityPub `Person`. */
export const ACTOR_PATH = '/fediverse/user/{identifier}'
/** Path of the actor's own inbox, where remote servers POST signed activities. */
export const INBOX_PATH = '/fediverse/user/{identifier}/inbox'
/** Path of the shared inbox, which receives activities for any recipient on this server. */
export const SHARED_INBOX_PATH = '/fediverse/inbox'
/** Path of the actor's followers collection, the `cc` of every article activity. */
export const FOLLOWERS_PATH = '/fediverse/user/{identifier}/followers'
/** Path of the NodeInfo 2.1 document that describes the server's software and usage. */
export const NODEINFO_PATH = '/nodeinfo/2.1'
/** Path of the actor's outbox, a paged `Create(Article)` for each published article. */
export const OUTBOX_PATH = '/fediverse/user/{identifier}/outbox'
/** Path where the ActivityPub `Article` of a published article is served. */
export const ARTICLE_PATH = '/fediverse/articles/{documentId}'

/**
 * Path where the ActivityPub `Note` of a moderator's reply is served: `/fediverse/notes/<documentId>`
 * of the comment. A visitor-facing identifier that never changes: remote servers store it.
 */
export const NOTE_PATH = '/fediverse/notes/{documentId}'

/** Everything Fedify can answer lives under these prefixes. */
export const FEDERATION_PREFIXES = ['/fediverse/', '/.well-known/', '/nodeinfo/']
