# Micelio Plugin Fediverse

Micelio's fediverse federation (ActivityPub) as a Strapi 5 plugin.

This is the plugin that ran inside `micelio-cms` as `src/plugins/fediverse`, moved with no change of behaviour (the first step of the cut-over of ADR-0017). It is not published yet.

## What it needs from the host

The plugin reads and writes content types it does not own, so a host provides them:

- `@micelio/strapi-plugin-core` (the default site, where the actor's profile and the object type live), `strapi-plugin-comments` (fediverse replies are stored as comments) and Strapi's `i18n`.
- `api::article.article` (`title`, `slug`, `description`, `cover`, `coverCredit`, `seo`, `category`, `tags`) and the single type `api::global.global` (`siteName`, `siteDescription`, `favicon`).
- The comments plugin extended with `fediverseUri`, `fediverseActorHandle`, `fediverseNoteUri` and `fediverseNoteRetracted`, and a middleware that hides `PENDING` and `REJECTED` comments from its public API. `test/app/` is a minimal host that does all of it.

## Configuration

The plugin is named `fediverse`, so its content types are `plugin::fediverse.follower`, `.interaction` and `.federated-article`, and its permission actions `plugin::fediverse.read` and `.manage`. A host enables it from `config/plugins.ts`, as `test/app/config/plugins.js` does. The variables are in [.env.example](.env.example):

| Variable                     | Default                                                   | Purpose                                                                                               |
| ---------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `FEDIVERSE_ENABLED`          | `false`                                                   | Read by the host's `config/plugins.ts`. Off: no routes and no content types.                          |
| `FEDIVERSE_ACTOR_IDENTIFIER` | required                                                  | Path of the actor URI. Never change it: remote servers key the account and its followers by that URI. |
| `FEDIVERSE_HANDLE_HOST`      | the host of `URL`                                         | Host of the handle when it is not the CMS host. A bare host; needs `URL`.                             |
| `URL`                        | `http://localhost:1337`                                   | Strapi's public origin. Activity ids built outside a request come from it.                            |
| `FRONTEND_URL`               | required in production; `http://localhost:3000` otherwise | Origin of the human-facing article links.                                                             |
| `FRONTEND_ARTICLE_PATH`      | `/blog/{slug}`                                            | Article path template.                                                                                |
| `FRONTEND_DEFAULT_LOCALE`    | `en`                                                      | Locale the frontend serves without a prefix.                                                          |
| `ENCRYPTION_KEY`             | required                                                  | Strapi's own: the actor's private key is stored encrypted with it.                                    |

The variables `FEDIVERSE_ACTOR_USERNAME`, `FEDIVERSE_ACTOR_NAME`, `FEDIVERSE_ACTOR_SUMMARY` and `FEDIVERSE_ACTOR_SOURCE_URL` are removed: a boot with one set stops, naming the field of the default site that replaces it (`server/src/utils/removed-variables.ts`).

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

The Release workflow (`.github/workflows/release.yml`) is started by the maintainer from the Actions tab. It defaults to a dry run that prints the version and the notes. Publishing needs a `release` environment with required reviewers (Settings → Environments), and a pull request title with a conventional prefix decides the version (section 7 of the standard).

## License

[AGPL-3.0-only](LICENSE). Third-party material is listed in [THIRD-PARTY.md](THIRD-PARTY.md).
