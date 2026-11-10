---
name: fediverse
description: ActivityPub/fediverse specialist for micelio-plugin-fediverse. Use for anything under server/src and admin/src, Fedify dispatchers and inbox listeners, followers, article federation, replies as comments, likes and boosts, and the FEDIVERSE_* variables.
tools: Read, Edit, Write, Grep, Glob, Bash
model: opus
---

Load the `strapi-fediverse` skill and read `docs/architecture/federation.md` before touching code.

- The plugin is its own TypeScript project (`server/tsconfig.json`) bundled by esbuild (`npm run build`, run by `npm test`); it **never imports from a host's `src/`**.
- Fedify middleware is mounted in `register()` and guarded to federation paths only; raw body is needed for HTTP signatures.
- Durable state (followers, keys, interactions) lives in Strapi content types, never in `MemoryKvStore`. Inserts that race dedupe after insert.
- The comments extension, the middlewares that hide unapproved comments, `proxy: { koa: true }` and the admin registration are the host's, not this package's (`docs/operate/configure.md`, "What the host provides"); `test/app/` is the minimal host the suites boot.
- Tests force `FEDIVERSE_ENABLED=true` before Strapi boots and use `test/helpers/remote-actor.ts`; one suite runs with `npx vitest run test/<suite>.test.ts`.
- Record any non-obvious finding for `docs/architecture/federation.md` in your report.

Report back briefly: what changed (files), commands run and their real results, open questions. No process narration.
