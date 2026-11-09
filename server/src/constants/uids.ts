/** Content type UIDs the plugin reads or writes. */

/** Articles, the objects the plugin federates. */
export const ARTICLE_UID = 'api::article.article'
/** Comments of `strapi-plugin-comments`, where fediverse replies are stored. */
export const COMMENT_UID = 'plugin::comments.comment'
/** The single type the actor's name, bio, avatar and header come from first. */
export const GLOBAL_UID = 'api::global.global'
/**
 * The core plugin's site (`@micelio/strapi-plugin-core`). The actor's profile, its name and bio
 * fallbacks and the object type are read from the default site (the row with `isDefault`).
 */
export const SITE_UID = 'plugin::micelio.site'
/** The plugin's remote followers, one row per actor. */
export const FOLLOWER_UID = 'plugin::fediverse.follower'
/** The plugin's likes and boosts, one row per type, actor and article. */
export const INTERACTION_UID = 'plugin::fediverse.interaction'
/** The plugin's federation state of an article, one row per article. */
export const FEDERATED_ARTICLE_UID = 'plugin::fediverse.federated-article'
