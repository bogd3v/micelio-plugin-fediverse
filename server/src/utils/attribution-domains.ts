import { handleHost } from './handle-host'

/**
 * The domains whose pages may credit the blog actor on a Mastodon link card (`attributionDomains`):
 * the host of `FRONTEND_URL`, then `FEDIVERSE_HANDLE_HOST` when it is set, lowercase, without
 * port and without repeats.
 *
 * @remarks
 * Mastodon compares them with the host of a shared page's canonical URL and its parent domains,
 * so `example.com` also credits `www.example.com`. `FRONTEND_URL` is read as set, not through
 * `frontendBaseUrl`: its development default (`localhost`) is no site's domain, and with both
 * variables unset the list is empty. See "Author attribution" in `docs/FEDIVERSE.md`.
 *
 * @throws `Error` as {@link handleHost} does; the plugin's `register()` already stopped the boot then.
 */
export function attributionDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const domains: string[] = []
  const frontendUrl = env.FRONTEND_URL?.trim()
  if (frontendUrl) {
    try {
      const { hostname } = new URL(frontendUrl)
      if (hostname) domains.push(hostname)
    } catch {
      // Not an absolute URL: it names no domain to credit.
    }
  }
  const handle = handleHost(env)
  if (handle) domains.push(new URL(`https://${handle}/`).hostname)
  return [...new Set(domains)]
}
