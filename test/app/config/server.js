module.exports = ({ env }) => ({
  host: '127.0.0.1',
  port: env.int('PORT', 0),
  // Behind a TLS-terminating proxy, ActivityPub URLs need `ctx.protocol` to follow the forwarded one.
  proxy: { koa: env.bool('TRUST_PROXY_PROTOCOL', true) },
  // Fan-out runs outside any request and builds every activity id from it (docs/FEDIVERSE.md).
  url: env('URL', 'http://localhost:1337'),
  app: { keys: env.array('APP_KEYS') },
  // No update check against the npm registry (Strapi still creates .strapi-updater.json).
  logger: { updates: { enabled: false } },
  cron: { enabled: !env.bool('STRAPI_DISABLE_CRON', false) },
})
