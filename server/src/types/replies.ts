/** Fediverse replies ingested as comments. */

/** A remote `Note` that may reply to an article or to a stored reply. */
export interface IncomingReply {
  /** The remote Note's id. */
  uri: string
  /** What the Note replies to (`inReplyTo`). */
  inReplyTo: string
  contentHtml: string
  actorId: string
  handle: string | null
  name: string | null
  avatar: string | null
}

/** Where a reply attaches: the article it belongs to and, for a nested reply, its parent comment. */
export interface ReplyParent {
  /** The article's documentId. */
  articleId: string
  /** The parent comment's documentId, or `null` for a top-level comment. */
  parentDocumentId: string | null
}

/** The author of a remote note, as a comment shows it. */
export interface RemoteAuthor {
  handle: string | null
  name: string | null
  avatar: string | null
}

/**
 * A note fetched from its server while resolving a thread, already checked: a
 * public `Note` whose author shares the origin it was served from.
 */
export interface FetchedNote {
  uri: string
  /** What the note replies to, or `null` when it starts its own thread. */
  inReplyTo: string | null
  contentHtml: string
  actorId: string
}

/** How thread resolution reaches remote servers; every call stops when `signal` aborts. */
export interface ThreadFetcher {
  /** The note at `uri`, or `null` when it cannot be fetched or fails the checks of `FetchedNote`. */
  fetchNote(uri: string, signal: AbortSignal): Promise<FetchedNote | null>
  /** The author of a fetched note; never throws, and falls back to empty fields. */
  describeAuthor(actorId: string, signal: AbortSignal): Promise<RemoteAuthor>
}

/** What reply handling needs from the federation: the blog's usernames and its article ids. */
export interface ReplyContext {
  /** Usernames the blog is mentioned by: its current handle and any former one. */
  actorUsernames: string[]
  /** Maps one of our ActivityPub article ids to its documentId, or null. */
  parseArticleUri(uri: string): string | null
}

/**
 * Outcome of storing, editing or removing a reply: the comment it changed, or
 * why nothing changed.
 */
export type IngestResult =
  { status: 'applied'; documentId: string } | { status: 'ignored'; reason: string }
