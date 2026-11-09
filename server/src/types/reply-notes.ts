/** The moderator's replies that federate as `Note`s. */

/** A comment of the comments plugin, as far as federating a reply needs it. */
export interface ReplyComment {
  id: number
  documentId: string
  content: string
  /** `true` when the author is an admin user (the plugin sets it on a moderator's reply). */
  isAdminComment: boolean | null
  removed: boolean | null
  blocked: boolean | null
  /** Set on every comment under a blocked comment (`blockCommentThread`). */
  blockedThread: boolean | null
  approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null
  /** The `Note` id once the reply has been federated; stays set after a `Delete`. Not the public `fediverseUri`. */
  fediverseNoteUri: string | null
  /** Whether the note was last retracted with a `Delete`. */
  fediverseNoteRetracted: boolean | null
  /** `api::article.article:<documentId>`. */
  related: string
  createdAt: string
  updatedAt: string | null
  /** The comment it answers, with what a federated reply needs to know of it. */
  threadOf: {
    fediverseUri: string | null
    fediverseActorHandle: string | null
    authorId: string | null
    removed: boolean | null
    blocked: boolean | null
    blockedThread: boolean | null
    approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null
  } | null
  /** The id of the admin user who wrote it, as the comments plugin stores it. */
  authorId: string | null
}

/** Where a reply goes: the remote note it answers and the remote author it is addressed to. */
export interface ReplyTarget {
  /** Id of the remote `Note` the reply answers (`inReplyTo`). */
  parentUri: string
  /** Actor id of the remote author of that note (`to`). */
  remoteAuthorId: string
  /** Their `@user@host`, when known, for the `Mention`. */
  remoteAuthorHandle: string | null
  /** The article page the reply links to. */
  articleUrl: URL
  /** `false` when the remote author is blocked on this site: the reply then goes to the followers only. */
  deliverToAuthor: boolean
}
