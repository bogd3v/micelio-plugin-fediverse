# Micelio Plugin Fediverse

Micelio's fediverse federation (ActivityPub) as a Strapi 5 plugin.

This is the plugin that ran inside `micelio-cms` as `src/plugins/fediverse`, moved out of the CMS in the cut-over of ADR-0017. It is released on npm as `@micelio/strapi-plugin-fediverse` from `0.7.0`; this is the `0.7` line, which declares `"micelio": "0.7"` (the Micelio release line it belongs to). The release notes and the upgrade steps from the plugin inside `micelio-cms` are in [docs/operate/upgrade-0.7.md](docs/operate/upgrade-0.7.md).

## What it needs from the host

The plugin reads and writes content types it does not own, so a host provides them:

- `@micelio/strapi-plugin-core` (the default site, where the actor's profile and the object type live), `strapi-plugin-comments` (fediverse replies are stored as comments) and Strapi's `i18n`.
- `api::article.article` (`title`, `slug`, `description`, `cover`, `coverCredit`, `seo`, `category`, `tags`) and the single type `api::global.global` (`siteName`, `siteDescription`, `favicon`).
- The comments plugin extended with `fediverseUri`, `fediverseActorHandle`, `fediverseNoteUri` and `fediverseNoteRetracted`, and a middleware that hides `PENDING` and `REJECTED` comments from its public API. `test/app/` is a minimal host that does all of it.

## Install and enable

1. Install the package at an exact version, with the plugins it builds on (see above) already in the host:

   ```bash
   npm install --save-exact @micelio/strapi-plugin-fediverse@0.7.0
   ```

   The peer range of `@micelio/strapi-plugin-core` is `^0.2.0`, the core the suites run on.

2. List it in `config/plugins.ts` as always enabled. The plugin reads `FEDIVERSE_ENABLED` itself, so its admin code is bundled whatever the variable is when the admin is built:

   ```ts
   export default () => ({
     fediverse: { enabled: true },
   })
   ```

3. Set the variables of [.env.example](.env.example): `FEDIVERSE_ENABLED=true`, `FEDIVERSE_ACTOR_IDENTIFIER` (the actor's address; never change it afterwards), `URL` (the public origin of Strapi) and `FRONTEND_URL`. Set `proxy: { koa: true }` in `config/server` behind a TLS-terminating proxy.

4. Build the admin and start Strapi. The page is **Fediverse** under **Site** in the Micelio sub-navigation. The host's root admin app does not register it: the package's `./strapi-admin` entry does. Content Manager → Sites → your site → **Fediverse** holds the profile (username, display name, summary, source URL, header); the site's **Hosts** hold the handle host (the first one).

5. Check that `GET /.well-known/webfinger?resource=acct:<user>@<handle host>` answers 200 on the site's domain (the frontend's route serves it) and read [docs/operate/configure.md](docs/operate/configure.md) for the rest (the delivery queue, what to check after enabling).

## Configuration

The plugin is named `fediverse`, so its content types are `plugin::fediverse.follower`, `.interaction` and `.federated-article`, and its permission actions `plugin::fediverse.read` and `.manage`. Each row of the three belongs to a site (`site`, a required relation made by `withSiteScope` of `@micelio/strapi-plugin-core`) and each site has its own actor key; see [Sites](docs/architecture/federation.md#sites) and, to upgrade, [docs/operate/configure.md](docs/operate/configure.md#upgrading-to-07-the-federation-state-belongs-to-a-site). A host lists it in `config/plugins.ts` as always enabled, as `test/app/config/plugins.js` does: the plugin reads `FEDIVERSE_ENABLED` itself, so its admin code is bundled whatever the variable is when the admin is built. The variables are in [.env.example](.env.example):

| Variable                     | Default                                                   | Purpose                                                                                                              |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `FEDIVERSE_ENABLED`          | `false`                                                   | Read by the plugin. Off: no routes, content types or permissions, and an empty plugin.                               |
| `FEDIVERSE_ACTOR_IDENTIFIER` | required                                                  | Path of the default site's actor URI. Never change it: remote servers key the account and its followers by that URI. |
| `URL`                        | `http://localhost:1337`                                   | Strapi's public origin. Activity ids built outside a request come from it.                                           |
| `FRONTEND_URL`               | required in production; `http://localhost:3000` otherwise | Origin of the human-facing article links.                                                                            |
| `FRONTEND_ARTICLE_PATH`      | `/blog/{slug}`                                            | Article path template.                                                                                               |
| `FRONTEND_DEFAULT_LOCALE`    | `en`                                                      | Deprecated: the site's Default locale is read first; this only when the site has none.                               |
| `ENCRYPTION_KEY`             | required                                                  | Strapi's own: the actor's private key is stored encrypted with it.                                                   |

The variables `FEDIVERSE_ACTOR_USERNAME`, `FEDIVERSE_ACTOR_NAME`, `FEDIVERSE_ACTOR_SUMMARY` and `FEDIVERSE_ACTOR_SOURCE_URL` are removed: a boot with one set stops, naming the field of the default site that replaces it (`server/src/utils/removed-variables.ts`). `FEDIVERSE_HANDLE_HOST` and the attribution list are dropped in 0.7 for the site's `hosts` (the first 0.7 boot pins your handle host as the first one; remove the variable afterwards), and `FRONTEND_DEFAULT_LOCALE` is deprecated for the site's Default locale. Kept: `FEDIVERSE_ENABLED`, `FEDIVERSE_ACTOR_IDENTIFIER`, `URL`, `FRONTEND_URL`, `FRONTEND_ARTICLE_PATH` and `ENCRYPTION_KEY`. Details: [docs/operate/upgrade-0.7.md](docs/operate/upgrade-0.7.md).

## Documentation

The documents are in [docs/](docs/), filed by reader: [how federation works](docs/architecture/federation.md) (contributors), [the public routes](docs/api.md) (integrators), [configuring a host](docs/operate/configure.md) (operators, including [what the host provides](docs/operate/configure.md#what-the-host-provides)), and the [log lines](docs/security/logging.md) and [keys](docs/security/keys.md) of the plugin.

## Getting started

```bash
npm ci
npm run check
```

`npm run check` builds the plugin (`dist/strapi-server.js`, one esbuild bundle: Fedify is ESM only and Strapi's CommonJS build cannot load it) and runs the suites, which boot a clean Strapi on SQLite with the plugin installed (`test/app/`). `npm pack` ships that bundle as the `./strapi-server` export.

Conventions, commands and structure are in [AGENTS.md](AGENTS.md); the rules every Micelio repository shares are in the [engineering standard](docs/engineering-standard.md). To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md).

## Releases

The Release workflow (`.github/workflows/release.yml`) is started by the maintainer from the Actions tab. It defaults to a dry run that prints the version and the notes. Publishing needs a `release` environment with required reviewers (Settings → Environments), and a pull request title with a conventional prefix decides the version (section 7 of the standard). Publishing also publishes the package to npm with provenance (`npm-root: true`, with the `NPM_TOKEN` secret of the `release` environment). The `breaking_changes` and `upgrade_notes` inputs are required when a pull request since the last release is breaking.

## License

[AGPL-3.0-only](LICENSE). Third-party material is listed in [THIRD-PARTY.md](THIRD-PARTY.md).
