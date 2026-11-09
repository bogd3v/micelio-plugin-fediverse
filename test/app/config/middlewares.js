// Strapi's defaults: the plugin runs on a clean host. The distribution's hardening is not here.
module.exports = [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  // Outer to hide-unapproved-comments, so it only enriches what survives pruning.
  'global::fediverse-comment-fields',
  'global::hide-unapproved-comments',
]
