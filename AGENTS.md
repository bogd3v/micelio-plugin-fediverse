# AGENTS.md

Instructions for coding agents working in this repository. Micelio's fediverse federation (ActivityPub) as a Strapi 5 plugin.

## Engineering standard

The rules shared by every Micelio repository live in [`docs/engineering-standard.md`](docs/engineering-standard.md). This repository follows standard version 2.0 (`standard: 2.0`; `npm run lint:standard` checks the copy against the hashes bundled in `@micelio/eslint-config`). This file adds what is specific to this repository and never relaxes the standard. The copy is kept in step by the Micelio bot's `docs(standard): sync to X.Y` pull requests: review and merge them, do not edit the file by hand.

## Commands

```bash
npm ci
npm run check            # typecheck, lint, format:check, test, lint:licenses and lint:standard
npm run build            # bundles server/src to dist/strapi-server.js (esbuild)
npm run dev              # the same, rebuilding on change
npm test                 # builds, then runs the suites; one suite: npx vitest run test/fediverse.test.ts
```

Two suites run only with a PostgreSQL server: `TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres npm test` (the queue tests, `test/fediverse-queue-postgres.test.ts` and `test/fediverse-delivery-restart.test.ts`).

## Structure

- `server/src/` — the plugin's server (entry `index.ts`; `constants/`, `types/`, `services/`, `controllers/`, `routes/`, `utils/`, `content-types/`). It is its own TypeScript project (`server/tsconfig.json`) bundled by esbuild into `dist/strapi-server.js`, the package's `./strapi-server` export. It never imports from a host's `src/`.
- `admin/src/` — the admin panel and page (`admin/tsconfig.json`). It is type-checked but not built or exported yet: the issues that follow decide how a host receives it.
- `test/` — the suites (`fediverse-*.test.ts`, `package.test.ts`), `strapi.ts` (boots the clean Strapi) and `helpers/`. `test/app/` is that clean Strapi 5 on SQLite: the plugin, `@micelio/strapi-plugin-core`, `strapi-plugin-comments` and users-permissions, with the content types and middlewares a host provides (see the README). `test/app/types/generated/` is written by `strapi ts:generate-types` (run it in `test/app` with `FEDIVERSE_ENABLED=true` and `FEDIVERSE_ACTOR_IDENTIFIER` set) when a content type of the app changes.
- `scripts/` — `check-licenses.mjs` (`npm run lint:licenses`) and `release/version.mjs` (the release plan, read by the Release workflow).
- `.github/workflows/` — `ci.yml`, `release.yml` and `pr-labels.yml`; CI calls the reusable workflows of `micelio-engineering`.

## Rules

- The architecture document of the plugin (`docs/FEDIVERSE.md`) and its skill (`strapi-fediverse`) are still in `micelio-cms`: read them before changing the federation. The plugin's name is `fediverse`, so the UIDs `plugin::fediverse.*` and the actions `plugin::fediverse.read` and `.manage` never change (standard, section 6).
- Dependencies are pinned as in `micelio-cms`: Fedify's packages and `postgres` exactly. The suites run on Strapi `5.59.0` and `strapi-plugin-comments` `3.2.4`, the versions the moved suites passed on.
- Types and constants: `server/src/types/<domain>.ts` and `server/src/constants/<domain>.ts` are the shared folders of the server (standard, TypeScript profile, section 4).
- Hard limits: `.claude/TEAM.md`. Never push, merge, tag, release or deploy without the human's approval, and never read secrets.
- Work moves through the gates of the Micelio factory ([`docs/factory.md`](https://github.com/bogd3v/micelio-engineering/blob/main/docs/factory.md) in `micelio-engineering`): planner, master, worker, blind reviewer, verifier, then the maintainer.
- Before 1.0.0 a breaking change raises `y` and everything else raises `z` (section 7). The bump is made by a `chore(release)` pull request before the tag.
