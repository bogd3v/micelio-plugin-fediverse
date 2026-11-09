/**
 * The frontend's base URL (`FRONTEND_URL`). Copy of the root's
 * `frontendBaseUrl`, which the plugin can't import (see "Where code goes" in
 * AGENTS.md): outside production it defaults to a local Nuxt dev server; in
 * production it is required, and the plugin's register() stops the boot
 * without it instead of federating links to another site.
 */
export function frontendBaseUrl(): string {
  const value = process.env.FRONTEND_URL?.trim()
  if (value) return value
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FRONTEND_URL is required in production: the URL of the frontend')
  }
  return 'http://localhost:3000'
}
