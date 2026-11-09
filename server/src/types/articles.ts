/** A published article as the federation layer sees it. */

/** The image attached to a federated article. */
export interface MediaRecord {
  url: string
  mime: string | null
  alternativeText: string | null
  /** Attribution line (HTML) owed by the image's license, when it has a credit. */
  creditHtml: string | null
}

/** A published article with a slug: what its `Article` object and frontend link are built from. */
export interface ArticleRecord {
  documentId: string
  title: string
  description: string
  slug: string
  locale: string | null
  /** When this version was published: Strapi stamps it again on every publish. */
  publishedAt: string
  updatedAt: string | null
  /**
   * The `published` of the federated object, which never changes once the `Create` is sent: the
   * `publishedAt` of the version that was sent first (`createSentAt` of its row), or `publishedAt`
   * for an article not federated yet.
   */
  firstPublishedAt: string
  image: MediaRecord | null
}

/** The ActivityPub type an article is sent as: `Article` or `Note` (default site `fediverse.objectType`). */
export type FederatedObjectType = 'article' | 'note'
