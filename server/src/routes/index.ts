export default {
  // The default prefix of a plugin's admin routes would be `/fediverse`, which Fedify's middleware
  // owns: it would put its security headers and rate limit on the panel and read the body of the
  // POST. A prefix of its own keeps the panel away from Fedify.
  admin: {
    type: 'admin',
    prefix: '/fediverse-panel',
    routes: [
      {
        method: 'GET',
        path: '/articles/:documentId/federation',
        handler: 'federation.find',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'POST',
        path: '/articles/:documentId/federate',
        handler: 'federation.federate',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      // The plugin page (permissions `plugin::fediverse.read` and `.manage`, checked in the handlers).
      {
        method: 'GET',
        path: '/diagnostics',
        handler: 'plugin-page.diagnostics',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'GET',
        path: '/followers',
        handler: 'plugin-page.followers',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'POST',
        path: '/followers/:documentId/block',
        handler: 'plugin-page.block',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'POST',
        path: '/followers/:documentId/unblock',
        handler: 'plugin-page.unblock',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'GET',
        path: '/failures',
        handler: 'plugin-page.failures',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
      {
        method: 'POST',
        path: '/failures/:documentId/retry',
        handler: 'plugin-page.retry',
        config: { policies: ['admin::isAuthenticatedAdmin'] },
      },
    ],
  },
  'content-api': {
    type: 'content-api',
    routes: [
      // Public like the per-article route below: aggregates only, cached for 60 s.
      {
        method: 'GET',
        path: '/articles/stats',
        handler: 'stats.batch',
        config: { auth: false },
      },
      {
        method: 'GET',
        path: '/articles/ranking',
        handler: 'stats.ranking',
        config: { auth: false },
      },
      {
        method: 'GET',
        path: '/articles/:documentId/stats',
        handler: 'stats.find',
        // Public: it exposes counts only, so no users-permissions role setup is needed.
        config: { auth: false },
      },
    ],
  },
}
