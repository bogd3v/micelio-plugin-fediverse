/** A published article as the federation layer sees it. */

/** The image attached to a federated article. */
export interface MediaRecord {
  url: string
  mime: string | null
  alternativeText: string | null
  /** Attribution line (HTML) owed by the image's license, when it has a credit. */
  creditHtml: string | null
}

/** One published locale of an article: what its entry in `contentMap` and `nameMap` is built from. */
export interface ArticleLocale {
  locale: string
  title: string
  description: string
  slug: string
  /** The cover's attribution line (HTML) in this locale, when the cover has a credit. */
  creditHtml: string | null
  /** When this locale's version went live and was last saved: a translation's change is a change of the object. */
  publishedAt: string | null
  updatedAt: string | null
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
  /** The latest change of the document in any published locale (`withLocales`). */
  updatedAt: string | null
  /**
   * The `published` of the federated object, which never changes once the `Create` is sent: the
   * `publishedAt` of the version that was sent first (`createSentAt` of its row), or `publishedAt`
   * for an article not federated yet.
   */
  firstPublishedAt: string
  image: MediaRecord | null
  /**
   * Every published locale of the document, the default locale first (this record's own version
   * among them): the entries of `contentMap`. `findPublishedArticle` fills it; `toRecord` alone
   * leaves the record's own version.
   */
  locales: ArticleLocale[]
}

/** The ActivityPub type an article is sent as: `Article` or `Note` (default site `fediverse.objectType`). */
export type FederatedObjectType = 'article' | 'note'
