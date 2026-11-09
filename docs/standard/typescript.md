# Micelio engineering standard: TypeScript profile

Profile `typescript` of standard version 2.0 (2026-11-06). Canonical copy: `bogd3v/micelio-engineering`, `docs/standard/typescript.md`.

How a repository in TypeScript on Node meets the core, `docs/engineering-standard.md`. Every Micelio repository pins it. Each section has the number of the section of the core it belongs to, and "section N" means that section of the core.

## 4. Code

### TypeScript

- Every TypeScript project **must** compile under `strict`, and `npm run typecheck` **must** cover every project of the repository, tests included.
- No `any`. Data that crosses a boundary (HTTP, CMS, storage, environment) enters as `unknown` and is narrowed by a schema or a type guard.
- Exported functions, composables and services declare their parameter and return types. Type-only imports use `import type`.

### Where types and constants live

Reach decides the place. A declaration starts in the file that uses it and is promoted when its reach grows.

| Reach | Lives in |
| --- | --- |
| One file | That file, not exported |
| One function's parameters or result, imported only together with that function | Next to the function, exported with it |
| Several files of one feature folder (`modules/theme/`, `app/islands/`, `src/utils/rate-limit/`) | That folder's `types.ts` or `constants.ts` |
| Several features, or data that crosses a boundary (CMS response, HTTP body, storage, theme) | The shared folder, in the file of its domain: `app/interfaces/<domain>.ts` and `app/constants/<domain>.ts` in the frontend, `src/types/<domain>.ts` and `src/constants/<domain>.ts` in the CMS |

- Shared folders are organised by domain (`post`, `site`, `theme`), never by kind of declaration and never one declaration per file. No `common`, `misc` or `shared` files.
- When a domain file passes about 200 lines it becomes a folder, `interfaces/<domain>/<topic>.ts`, with an `index.ts` that re-exports it. Consumers import from the folder's index (`~/interfaces`), so a move never touches them.
- A shared file holds declarations only: no logic and no runtime imports.
- A shared constant is a value with a meaning beyond one function: a limit, a path, a key, a prefix, a content type UID. A pattern or literal that only makes sense inside one function stays with it, named, at the top of its file.
- A self-contained unit keeps its own copies on purpose: a boot migration, the fediverse plugin, a theme package.
- Export only what another file imports. An export nothing uses is removed.
- Each `AGENTS.md` names the shared folders of its repository, and a check fails when a type or constant declared outside these places is imported by two or more files.

### Style

- Each repository has exactly one formatter configuration, checked in CI. Formatting is never discussed in review: if the formatter accepts it, it is fine.
- `async`/`await` with `try`/`catch`. No `.then()`, `.catch()` or `.finally()` chains. `Promise.all`, `race`, `any` and `allSettled` are fine when awaited. `new Promise` only inside a small helper that adapts an event or callback API.
- Pure logic lives in small functions without framework imports (`app/helpers/`, `src/utils/`) and is unit-tested there. Components, controllers and routes stay thin.
- A file **should** stay under about 500 lines and do one job; split it when it passes either limit.
- Within a file the order is: imports, types, constants, the exported API, private helpers.
- Dead code is deleted, not commented out. Git keeps the history.

### Errors and logging

- Catch an error only where it can be handled or given context. Never swallow one: an empty `catch` needs a comment that says why nothing is lost.
- At a boundary, turn the error into the right answer for the caller (an HTTP status and code, a neutral fallback) and log the cause on the server.
- "Not found" is a normal result, not an exception.
- Use the platform's logger (`strapi.log` in the CMS, `console.warn` and `console.error` in Nitro). `console.log` does not ship outside scripts.
- Logs **must not** contain secrets, tokens, email addresses or raw IP addresses.

### HTTP APIs

- An API that Micelio designs answers an error as a problem detail (RFC 9457, `application/problem+json`): `type`, `title`, `status`, `detail`, and a stable, machine-readable `code` as an extension member. A client branches on `code`, never on the text.
- Its reference is an OpenAPI document generated from the schemas that validate its requests and responses. Lint fails when the document drifts from them.
- An API whose format belongs to a framework (Strapi's content API) keeps that format.

### Doc comments (TSDoc)

Doc comments follow [TSDoc](https://tsdoc.org/). They are what an editor shows on hover, what an agent reads before calling a function, and what the API reference is generated from.

What **must** have one:

- Every exported function, composable, service, class and constant.
- Every exported type and interface, and each field whose meaning its name and type do not make obvious.
- A component prop or emit that needs more than its name, on the `defineProps` or `defineEmits` type.

A default export the framework discovers (a page, a route handler, a core controller) needs none: route handlers are documented in `docs/api.md`. Private declarations get one only when it helps.

How it is written:

- The first sentence is the summary: what the thing is, returns or guarantees, in the present tense, able to stand alone in a list. When that is all there is to say, the comment is one line: `/** … */`.
- After it comes only what the signature cannot say: when the result is `null`, side effects, units, caching, who may call it, why it exists.
- Never repeat the name or the types, and never write types in braces: TypeScript already has them.
- Identifiers go in backticks. Point to an ADR or a document instead of copying it.
- A tag is used only when it adds information:

| Tag | Use it for |
| --- | --- |
| `@param name - …` | A parameter whose meaning, unit or allowed values its name and type do not give |
| `@returns` | A result the summary does not already describe |
| `@throws` | Every error the caller is expected to handle, with its status or code |
| `@defaultValue` | An optional field or prop that has a default |
| `@example` | An input format or a call that is not obvious; the code is fenced and compiles |
| `@remarks` | The longer explanation, after the summary |
| `@see`, `{@link}` | A related symbol, ADR or document |
| `@deprecated` | The replacement and the release that removes it (section 7) |
| `@public` | A slot API: part of the theme contract, bound by sections 6 and 7 |
| `@internal` | Exported only for tests or sibling files; not for themes |

```ts
/** The main navigation links, shared by the header variants. */
export function useNavLinks(): ComputedRef<SiteNavLink[]>

export interface SearchOptions {
  query: string
  /** Restricts the search to one category, by slug. */
  category?: string
  /**
   * Results per page, at most 50.
   *
   * @defaultValue 10
   */
  pageSize?: number
}

/**
 * Minutes an average reader needs for a text, rounded up.
 *
 * @remarks
 * Code blocks count at half speed. An empty text answers 0, not 1.
 *
 * @param markdown - The article body as stored, before rendering.
 * @param wordsPerMinute - Reading speed of the locale.
 * @throws `RangeError` when `wordsPerMinute` is not positive.
 *
 * @example
 * ```ts
 * readingMinutes('One two three.', 180) // 1
 * ```
 */
export function readingMinutes(markdown: string, wordsPerMinute = 230): number
```

- A comment changes in the same pull request as the behaviour it describes. A comment that is wrong is a bug.
- Lint checks the syntax (`tsdoc/syntax`) and that exported declarations have a comment (`jsdoc/require-jsdoc`, public only). The reference of the public surface, which today is the slot APIs of the theme contract, is generated from these comments, and lint fails when it drifts.

### Comments and suppressions

- Comments inside a function are short and say why, not what. Anything longer goes in `docs/` or an ADR and the comment points to it.
- A `TODO` names its issue: `// TODO(#123): …`. Without an issue it is not a plan.
- A suppression (`eslint-disable-next-line`, `@ts-expect-error`) covers one line and carries its reason on that line. `@ts-ignore`, `@ts-nocheck` and file-wide disables are not used.

## 8. Tests

- Levels, from cheapest to most expensive: unit (pure helpers), component, integration (a real build, a real Strapi on SQLite), end to end (Playwright), contract (theme checks, visual regression, axe) and performance budgets. `AGENTS.md` lists the commands of each repository.
- Prefer the real thing to a mock. The CMS suites boot a real Strapi; the frontend replaces Strapi only at the HTTP boundary, with one shared mock server.

## 10. Dependencies, licences, supply chain and runtime

- A new production dependency **must** be justified in the pull request: what it replaces, what it weighs, its licence and who maintains it. Prefer the platform (principle 5).
- Licences are checked against the allowlist (`npm run lint:licenses`, shipped with the shared configuration packages). Third-party material keeps its licence file next to it, is listed in `THIRD-PARTY.md` and annotated in `REUSE.toml`.
- The lockfile is committed and never edited by hand. CI installs with `npm ci`.
- Pin exactly what breaks on minor versions (0.x packages, WASM runtimes); use ranges for the rest.
- Dependabot proposes grouped minor and patch updates weekly. A major upgrade is done by hand, in its own pull request, with the full suite.
- An alert that cannot be fixed yet is written down with the reason the risk is accepted.
- GitHub Actions are pinned by commit SHA, with the version in a comment.
- Every published artifact (an image, a theme package) carries a software bill of materials and a signed build provenance attestation, and the operator documentation says how to verify them.
- The OpenSSF Scorecard runs on every repository. A finding is fixed or written down with the reason, like a dependency alert.
- All repositories run the same Node major. `.nvmrc` is the source: CI reads it, and `engines` and `@types/node` match it.

## 11. Git, pull requests and review

### Pull requests

- `npm run check` passes locally before the pull request is opened. CI is the gate; a red check is never merged around.

### Done

Besides the items of section 11, "Done":

- New and changed exports have their TSDoc comment.

## 12. Documentation, decisions and planning

### Organised by reader

- Reference is generated from its source of truth whenever one exists, and lint fails when it drifts, as the theme schema and reference already do. For code, the source of truth is the TSDoc comment (section 4).

## 14. Starting a new repository

The template of `micelio-engineering` (`template/`) produces all of this; the list is what it must contain.

- [ ] `LICENSE`, `REUSE.toml`, `THIRD-PARTY.md` and the licence allowlist check
- [ ] `README.md` and the short `CONTRIBUTING.md` that links Micelio's canonical one (section 1); `SECURITY.md` and `CODE_OF_CONDUCT.md` only when the repository has something to add to the organisation's
- [ ] `AGENTS.md` with the pinned version of this standard, `CLAUDE.md`, `.claude/TEAM.md` and the copy of this standard
- [ ] `.editorconfig`, `.nvmrc` and `.env.example`
- [ ] A `version` in `package.json`, the shared configuration packages, and the release workflow of section 7
- [ ] The scripts `dev`, `build`, `typecheck`, `lint`, `lint:fix`, `lint:standard`, `test` and `check`
- [ ] CI with the required checks of section 15 called from the reusable workflows of `micelio-engineering`, the DCO check, Dependabot and the Scorecard workflow
- [ ] The pull request template, the issue templates, the title-to-label workflow and the release notes configuration
- [ ] `main` protected by the organisation rulesets: changes arrive by pull request, required checks pass, no force push
- [ ] The Micelio bot installed on the repository (section 16)

A plugin repository also needs:

- [ ] The Strapi plugin SDK scaffold, publishing `@micelio/strapi-plugin-<name>`
- [ ] A suite that boots a clean Strapi with the plugin installed, next to the unit tests
- [ ] The release line of the core it supports, declared in `package.json` (section 7)
- [ ] Its hooks, blocks and states documented from their TSDoc (section 6)

## 15. Required checks

Every repository exposes the same script names, and `npm run check` runs the fast ones in the order CI does.

| Check | Script or workflow | In `check` |
| --- | --- | --- |
| Types | `npm run typecheck` | Yes |
| Lint, including the repository's own rules | `npm run lint` | Yes |
| Format | `npm run format:check`, or the stylistic rules inside lint | Yes |
| Tests with the coverage floor | `npm run test` or `npm run test:coverage` | Yes |
| Licences | `npm run lint:licenses` and `reuse lint` | Yes (allowlist) |
| The copy of this standard | `npm run lint:standard` | Yes |
| Build | `npm run build` | No |
| Known vulnerabilities | `npm audit --audit-level=critical` | No |
| Sign-off | The `DCO` workflow | No |
| The repository's own suites | Integration, end to end, theme checks, performance budgets | No |
| The contract with the other repository | The contract suite against a real CMS | No |
| Supply chain | SBOM and provenance on every published artifact; the Scorecard workflow | No |

## 16. Changing this standard

- `npm run lint:standard` fails when the local copy does not match the version pinned in `AGENTS.md`. A repository may stay on an older version on purpose; the lint checks the pinned one.
