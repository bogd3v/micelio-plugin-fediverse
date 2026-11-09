module.exports = ({ env }) => ({
  auth: { secret: env('ADMIN_JWT_SECRET') },
  apiToken: { salt: env('API_TOKEN_SALT') },
  transfer: { token: { salt: env('TRANSFER_TOKEN_SALT') } },
  secrets: { encryptionKey: env('ENCRYPTION_KEY') },
  // The suites call the APIs. `npm run test:admin` builds the admin and serves it (test/admin/).
  serveAdminPanel: env.bool('SERVE_ADMIN_PANEL', false),
})
