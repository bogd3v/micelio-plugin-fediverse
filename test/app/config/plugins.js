const path = require('node:path')

// The plugin as a host installs it: Strapi reads the repository's package.json and loads the
// built `./strapi-server` export, so the suites run `npm run build` first (test/global-setup.ts).
module.exports = ({ env }) => ({
  // Always enabled: Strapi bundles a plugin's admin code only when it is enabled while the admin is
  // built, and a host builds it with `FEDIVERSE_ENABLED` unset. The plugin reads the switch itself:
  // off, it is an empty plugin (no routes, content types, hooks or permissions).
  fediverse: {
    enabled: true,
    // The repository, or the unpacked tarball when test/package.test.ts sets FEDIVERSE_PLUGIN_PATH.
    resolve: env('FEDIVERSE_PLUGIN_PATH', path.resolve(__dirname, '../../..')),
  },
  micelio: {
    enabled: true,
    resolve: path.dirname(require.resolve('@micelio/strapi-plugin-core/package.json')),
  },
  'users-permissions': {
    enabled: true,
    resolve: path.dirname(require.resolve('@strapi/plugin-users-permissions/package.json')),
  },
  comments: {
    enabled: true,
    resolve: path.dirname(require.resolve('strapi-plugin-comments/package.json')),
    config: {
      enabledCollections: ['api::article.article'],
      approvalScores: {
        enabled: true,
        thresholds: { new: 0, approved: 1, rejected: -1, blocked: -10 },
      },
      moderation: { enabled: true, removeBlocked: false },
      nested: { enabled: true, depth: 10, maxDepth: 10 },
      glow: { enabled: false, emailNotifications: false },
      autopopulate: { populate: { author: { fields: ['name', 'email', 'avatar'] } } },
      entryRelation: {
        contentTypes: [{ name: 'api::article.article', field: 'comments' }],
      },
    },
  },
})
