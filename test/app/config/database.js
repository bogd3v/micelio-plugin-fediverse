const path = require('node:path')

// SQLite, one file per test worker (test/strapi.ts sets DATABASE_FILENAME); PostgreSQL when
// TEST_DATABASE_URL is set, as in production (test/strapi.ts sets the DATABASE_* variables).
module.exports = ({ env }) => {
  const client = env('DATABASE_CLIENT', 'sqlite')
  if (client === 'postgres') {
    return {
      connection: {
        client,
        connection: {
          connectionString: env('DATABASE_URL'),
          host: env('DATABASE_HOST', 'localhost'),
          port: env.int('DATABASE_PORT', 5432),
          database: env('DATABASE_NAME', 'strapi'),
          user: env('DATABASE_USERNAME', 'strapi'),
          password: env('DATABASE_PASSWORD'),
          ssl: env.bool('DATABASE_SSL', false),
          schema: env('DATABASE_SCHEMA', 'public'),
        },
        pool: { min: 2, max: 10 },
        acquireConnectionTimeout: 60000,
      },
    }
  }
  return {
    connection: {
      client: 'sqlite',
      connection: { filename: path.resolve(__dirname, '..', env('DATABASE_FILENAME')) },
      useNullAsDefault: true,
    },
  }
}
