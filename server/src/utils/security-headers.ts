/**
 * Browser security headers for federation responses.
 *
 * @remarks
 * Fedify answers before `strapi::security` runs, so these responses would carry
 * none. The values match that middleware: one-year HSTS with subdomains,
 * `nosniff`, framing limited to the same origin. The plugin keeps its own copy
 * of them (it is a self-contained unit).
 */
export const FEDERATION_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Referrer-Policy': 'no-referrer',
}
