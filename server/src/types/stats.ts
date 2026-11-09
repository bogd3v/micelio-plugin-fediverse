/** Per-article fediverse counters and the ranking built on them. */

/** Fediverse counters of one article; blocked actors do not count. */
export interface ArticleStats {
  likes: number
  boosts: number
  /**
   * Approved comments with a `fediverseUri` that are not removed or blocked;
   * local comments do not count.
   */
  replies: number
}

/** An article's place in the ranking: its counters and documentId. */
export interface RankedArticle extends ArticleStats {
  documentId: string
}

/** Page and filters of the most-discussed ranking. */
export interface RankingOptions {
  /** 1-based. */
  page: number
  pageSize: number
  /** Locale of the ranked articles; the default locale when omitted. */
  locale?: string
  /** Category slug. */
  category?: string
  /** Tag slug. */
  tag?: string
  /** Text the title must contain, case-insensitive. */
  search?: string
}

/** One page of the ranking, most discussed first, with its pagination. */
export interface RankingPage {
  data: RankedArticle[]
  meta: { pagination: { page: number; pageSize: number; pageCount: number; total: number } }
}
