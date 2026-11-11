# AGENTS.md

Instructions for coding agents working in this repository. Micelio's fediverse federation (ActivityPub) as a Strapi 5 plugin.

## Engineering standard

The rules shared by every Micelio repository live in [`docs/engineering-standard.md`](docs/engineering-standard.md). This repository follows standard version 2.0 (`standard: 2.0`; `npm run lint:standard` checks the copy against the hashes bundled in `@micelio/eslint-config`). This file adds what is specific to this repository and never relaxes the standard. The copy is kept in step by the Micelio bot's `docs(standard): sync to X.Y` pull requests: review and merge them, do not edit the file by hand.

## Commands

```bash
npm ci
npm run check            # typecheck, lint, format:check, test, lint:licenses and lint:standard
npm run build            # bundles server/src and admin/src to dist/ (esbuild, scripts/build.mjs)
npm run dev              # the same, rebuilding on change
npm test                 # builds, then runs the suites; one suite: npx vitest run test/fediverse.test.ts
```

Two suites run only with a PostgreSQL server: `TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres npm test` (the queue tests, `test/fediverse-queue-postgres.test.ts` and `test/fediverse-delivery-restart.test.ts`).

The `test` script sets `UV_THREADPOOL_SIZE=64`: Vitest runs one worker per core in one process, they share libuv's 4-thread pool, and the Strapi boots of the suite compete for it until deliveries time out. The variable must be in the process environment (the script); set in `vitest.config.mts` it is too late. A single suite run with `npx vitest run` does not need it.

## Structure

- `server/src/` — the plugin's server (entry `index.ts`; `constants/`, `types/`, `services/`, `controllers/`, `routes/`, `utils/`, `content-types/`). It is its own TypeScript project (`server/tsconfig.json`) bundled by esbuild into `dist/strapi-server.js`, the package's `./strapi-server` export. The host lists the plugin as always enabled: it reads `FEDIVERSE_ENABLED` itself. It never imports from a host's `src/`.
- `admin/src/` — the admin panel and page (`admin/tsconfig.json`). The admin entry (`index.ts`: the Fediverse page and the article panel) is bundled into `dist/strapi-admin.mjs` and `.js`, the package's `./strapi-admin` export.
- `docs/` — the documents, filed by reader: `architecture/federation.md` (how the plugin works, for contributors; the findings behind each decision), `api.md` (the public routes), `operate/configure.md` (the operator: what the host provides, every variable, enabling, the delivery queue) and `operate/upgrade-0.7.md` (the upgrade notes of 0.7) and `security/` (`logging.md`, the `[fediverse]` log lines and the security event; `keys.md`, the actor key and its algorithms; `data.md`, the data the plugin holds and its levels), plus the shared standard (`engineering-standard.md`, `standard/`).
- `.claude/skills/strapi-fediverse/` — the skill for federation work, with the `fediverse` agent (`.claude/agents/fediverse.md`).
- `test/` — the suites (`fediverse-*.test.ts`, `package.test.ts`), `strapi.ts` (boots the clean Strapi) and `helpers/`. `test/app/` is that clean Strapi 5 on SQLite: the plugin, `@micelio/strapi-plugin-core`, `strapi-plugin-comments` and users-permissions, with the content types and middlewares a host provides (see the README). `test/app/types/generated/` is written by `strapi ts:generate-types` (run it in `test/app` with `FEDIVERSE_ENABLED=true` and `FEDIVERSE_ACTOR_IDENTIFIER` set) when a content type of the app changes.
- `scripts/` — `build.mjs` (`npm run build`), `check-licenses.mjs` (`npm run lint:licenses`) and `release/version.mjs` (the release plan, read by the Release workflow).
- `.github/workflows/` — `ci.yml`, `release.yml` and `pr-labels.yml`; CI calls the reusable workflows of `micelio-engineering`.

## Rules

- Before changing federation code, read `docs/architecture/federation.md` and the skill `strapi-fediverse`. A change to behaviour, a variable, a route, a log line or a key changes the document of its reader (`docs/api.md`, `docs/operate/configure.md`, `docs/security/`) in the same pull request. The plugin's name is `fediverse`, so the UIDs `plugin::fediverse.*` and the actions `plugin::fediverse.read` and `.manage` never change (standard, section 6).
- Dependencies are pinned as in `micelio-cms`: Fedify's packages and `postgres` exactly. The suites run on Strapi `5.59.0` and `strapi-plugin-comments` `3.2.4`, the versions the moved suites passed on.
- Types and constants: `server/src/types/<domain>.ts` and `server/src/constants/<domain>.ts` are the shared folders of the server (standard, TypeScript profile, section 4).
- Hard limits: `.claude/TEAM.md`. Never push, merge, tag, release or deploy without the human's approval, and never read secrets.
- Work moves through the gates of the Micelio factory ([`docs/factory.md`](https://github.com/bogd3v/micelio-engineering/blob/main/docs/factory.md) in `micelio-engineering`): planner, master, worker, blind reviewer, verifier, then the maintainer.
- Before 1.0.0 a breaking change raises `y` and everything else raises `z` (section 7). The bump is made by a `chore(release)` pull request before the tag.
