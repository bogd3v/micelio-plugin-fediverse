# Micelio engineering standard

Version 1.7 (2026-11-04). Canonical copy: `bogd3v/micelio-engineering`, `docs/engineering-standard.md` (in `bogd3v/micelio` until bogd3v/micelio-engineering#6 moves it). Every repository of Micelio carries a copy at the same path, synced as section 16 says.

These are the rules shared by every repository of **Micelio**: the frontend (`micelio`), the reference distribution of the CMS (`micelio-cms`), the Strapi plugins (`micelio-plugin-core` and the ones that follow it), theme packages, the theme registry and the tooling (`micelio-engineering`), all of them on Node. They apply the same way to human contributors and to coding agents. What is specific to one repository (its stack, commands, folders and naming) stays in that repository's `AGENTS.md`. The standard is Micelio's, not bogd3v's: other projects of the organisation, in other languages or under other licences, are not bound by it.

**Must** marks a rule that blocks a pull request. **Should** marks the default: a pull request may deviate when it says why.

## 1. How the documents fit together

Each fact has one home. Other documents link to it instead of repeating it.

| Document | Holds |
| --- | --- |
| `docs/engineering-standard.md` | The rules every repository shares (this file). The canonical copy lives in `micelio-engineering`; each repository keeps a copy for the agents, synced by the Micelio bot and checked by `lint:standard` against the version pinned in `AGENTS.md` (section 16) |
| `AGENTS.md` | The repository's own conventions, commands and structure, and the version of this standard it follows. It may add rules or tighten these, never relax them |
| `CLAUDE.md` | Imports `AGENTS.md` and `.claude/TEAM.md`; the standard is read by section, as section 13 says |
| `.claude/TEAM.md`, `.claude/agents/` | How the agent team is organised and its hard limits |
| `.claude/skills/` | Procedures: the steps for one kind of task |
| `docs/adr/` | Decisions that are expensive to undo, and every accepted exception to this standard |
| `docs/` | Documentation, organised by reader (section 12) |
| `README.md` | What Micelio is and the shortest path to a running site |
| `CONTRIBUTING.md` | The terms of a contribution: a short file that links Micelio's canonical one in `micelio-engineering` (licence, the theme exception, the DCO) and adds only what is specific to the repository |
| `GOVERNANCE.md`, `TRADEMARKS.md` | Who decides what, and how the Micelio name and logo may be used. Micelio's, in `micelio-engineering`; repositories link to them |
| `CODE_OF_CONDUCT.md`, `SECURITY.md` | How people treat each other and how to report a vulnerability. Served to every repository from `bogd3v/.github`; a repository carries its own only to say something more |
| GitHub releases | What changed in each version and what an upgrade needs |
| GitHub issues and milestones | The plan and its progress |

- When two documents disagree, the order is: ADR, this standard, `AGENTS.md`, skill. The disagreement is a bug: fix the document that lost in the same pull request.
- The files an agent loads in every session (`AGENTS.md`, `CLAUDE.md` and `.claude/TEAM.md`; this file is read by section, not loaded whole) hold rules and pointers. Knowledge about one subsystem goes in `docs/` or in a skill, where it is read on demand. Keep a repository's own three files under about 3,500 words in total.
- Files in `docs/` use lowercase kebab-case names (`static-mode.md`). The community files at the root keep their conventional uppercase names.

## 2. Principles

1. **A rule that matters is checked by a machine.** Lint, types, tests and budgets enforce the standard; review catches what they cannot. When the same review comment appears a third time, it becomes a check.
2. **The core carries no site.** No name, domain, address, handle or content of any one site (BogDev included) lives in code, defaults or generated output. A fresh instance is neutral until its owner configures it.
3. **A contract is a promise.** What themes, the other repository, site operators and visitors depend on changes only by the rules of sections 6 and 7.
4. **Budgets, not intentions.** Weight, accessibility and zero third-party requests are measured in CI. A theme or a change that fails a budget does not ship.
5. **The platform first.** HTML and CSS before JavaScript, the framework before a library, a few lines of our own before a dependency.
6. **Small steps that can be undone.** One concern per pull request. A decision that is expensive to undo gets an ADR before the code.
7. **Evidence over claims.** A change is reported with the commands that were run and their real numbers, including what was not verified.

## 3. Language and naming

- **English** for everything in the repository: identifiers, comments, commit messages, pull requests, documentation and test names. This holds even when an issue or a design document names something in Spanish.
- User-facing text goes through i18n and **must** land in every supported locale (`en`, `es`) in the same pull request.
- Values that belong to an external contract keep their spelling: CMS slugs, stored values, design token names.
- A name says what the thing is or does in the domain (`loadSiteCached`, `drafts-access`), not how it is built. Booleans read as a statement (`isOpen`, `hasDrafts`).
- File and folder naming is per repository; each `AGENTS.md` has the table.

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

## 5. Configuration and secrets

- Every environment variable appears in `.env.example` with a comment, and in the operator documentation.
- A variable has a neutral default or is required. In production, a missing required value **must** stop the boot with a message that names it.
- Secrets never enter the repository, a fixture, a log, an issue, a pull request or an agent transcript. `.env.example` is how anyone learns the variable names.
- Per-site values come from configuration or from the CMS. Defaults in code are neutral (principle 2).

## 6. Contracts and compatibility

| Contract | Source of truth | A breaking change is |
| --- | --- | --- |
| Theme contract: roles, modes, layout variants, public hooks, slots and slot APIs | ADR 0005; `modules/theme/contract.ts`, `app/theme/hooks.json` and the schema and reference generated from them | Removing or renaming any of them, or changing a hook's markup so that existing selectors stop matching |
| Content API between CMS and frontend: content types, components, blocks, response shapes | The schemas in `micelio-cms`; `docs/api.md` in `micelio` | Removing or renaming a field, a block or a route, or changing its type |
| API token permissions | `src/migrations/api-tokens.ts` in `micelio-cms`; `docs/security.md` in `micelio` | Any difference between the two |
| Operator interface: environment variable names, image names and tags, Compose service and volume names, health endpoints, backup paths | `.env.example`, the Compose files, the operator documentation | Renaming or removing one, or an upgrade that needs a manual step |
| Visitor-facing identifiers: URLs, feeds, fediverse actor ids, cookie and storage keys | The ADR that introduced each | Any change that breaks a link, a follow or a stored preference |
| Stored data: database schema and boot migrations | `src/migrations/` | A migration that the previous release's code cannot run against, or that cannot run twice |
| Block contract: the catalogue of blocks, each with its id, schema, presentation options, cost and static alternative | ADR 0018; `contract/blocks.ts` in `micelio-plugin-core` and the schema and reference generated from it | Removing or renaming a block or an option, or changing the schema of a block that stored content uses without a content migration |
| Plugin hooks API: the hooks the core exposes to other plugins and their payloads | `micelio-plugin-core`, the reference generated from the TSDoc of the hooks | Removing or renaming a hook, or changing a payload |
| Editorial states and transitions | ADR 0017; the `transitions` service of `micelio-plugin-core` | Removing or renaming a state or a transition, or changing who may perform one by default |
| Site export format | `docs/export-format.md` in `micelio-plugin-core` | An archive the previous release can no longer import |

- Every contract keyed by content is keyed by site (ADR 0017): a content type, a hook payload, a policy and an export name the site they belong to.
- Adding is free when it is optional and has a default that keeps existing consumers working. Removing, renaming or changing a meaning is a breaking change.
- A breaking change **must** have an ADR, a migration path for whoever depends on it, and upgrade notes in the release (section 7). Before 1.0.0 only the upgrade notes are required (section 7, "Before 1.0.0").
- A change that crosses both repositories goes CMS first (behind a default that keeps the current frontend working), frontend second, each in its own pull request that references the same issue.
- Generated artifacts (theme schema, theme reference) are regenerated in the pull request that changes their source. Lint fails on drift.
- Boot migrations are idempotent, self-contained (they keep their own constants) and tested.

## 7. Versions and releases

Every repository that publishes something another person pins follows [Semantic Versioning 2.0.0](https://semver.org/).

### What a version promises

The public interface of a repository is the set of contracts of section 6 that it owns. Everything else is internal and may change in any release: the file layout, internal modules, core classes that are not public hooks, markup outside the hooks, and dependencies an operator does not install.

| Part | Changes when | Examples |
| --- | --- | --- |
| MAJOR | A contract of section 6 breaks, or the upgrade needs the operator to act | A removed or renamed variable, field, route or hook; a new required variable; a manual migration step; a higher minimum Node or PostgreSQL major; a new major of the theme contract |
| MINOR | Something is added without breaking, or something is deprecated | A new feature, optional variable, content type, field or block; a new hook, slot or layout variant (a minor of the theme contract); a new plugin hook, block option or editorial state |
| PATCH | No contract changes | A fix, a security fix, performance, refactoring, a dependency update, documentation |

- The bump follows the pull request titles merged since the last release, and the highest wins: a `!` after the type or scope is a major (`feat(theme)!: …`), `feat` is a minor, everything else a patch. Before 1.0.0 the scale moves down one step ("Before 1.0.0", below): a breaking change raises `y` and everything else, `feat` included, raises `z`.
- A breaking pull request carries the `!` in its title and a `BREAKING CHANGE:` paragraph in its description that says who is affected and what to do.
- The effect decides, not the prefix: a fix that changes behaviour a site could depend on is released as what it is, and so is a feature that adds a refusal (something that was accepted now fails) or a boot failure (an install that started now stops). A refusal and a boot failure are breaking changes and follow the rules of one (section 6; before 1.0.0, "Before 1.0.0" below).

### Before 1.0.0

While the version is `0.y.z` the project is alpha: nothing is stable and any `0.y` release may break a contract of section 6. A breaking change raises `y` and everything else raises `z`. It needs no deprecation period and no ADR (an expensive decision still gets one, section 12), only the `!` in the pull request title, a `BREAKING CHANGE:` paragraph in its description and upgrade notes in the release. Never describe a `0.y` release as stable. `1.0.0` is cut by an ADR, when the registry accepts third-party themes or the first site outside bogd3v runs in production, whichever comes first.

### The release line

- `micelio` and `micelio-cms` share MAJOR and MINOR and raise them together; each has its own PATCH. "Micelio 1.4" is any `micelio 1.4.z` with any `micelio-cms 1.4.z`.
- Upgrades go CMS first. The CMS of a release line also serves the frontend of the previous MINOR, so a site upgrades one side at a time without downtime. Across a MAJOR, the upgrade notes give the order.
- The builder image carries the version of `micelio`.
- A theme package has its own version (ADR 0008) and declares the theme contract it needs as `major.minor`. A minor of the contract ships in a MINOR of the core, a major of the contract in a MAJOR.
- A plugin package (`@micelio/strapi-plugin-*`) has its own version and declares the release line of the core it supports as `major.minor` (ADR 0017). The distribution `micelio-cms` raises a MINOR when it raises the plugins it installs, and a MAJOR when one of them does.
- The shared configuration packages (`@micelio/eslint-config`, `@micelio/tsconfig`, `@micelio/prettier-config`) have their own versions; a repository pins them like any dependency.
- This standard is versioned as `major.minor`.

### Tags and artifacts

- A release is the tag `vX.Y.Z` on `main`, a GitHub release, and images tagged `X.Y.Z` and `X.Y`. The `version` in `package.json` matches the tag.
- `latest` points at the newest stable release. Builds of `main` are published as `edge` and by commit SHA.
- A release candidate is `vX.Y.Z-rc.N` and never moves `X.Y` or `latest`.
- A published version never changes. A bad release is fixed by the next patch, not by moving a tag.

### Release notes

- Notes are generated from pull request titles and grouped by type. "Breaking changes" and "Upgrade notes" come first and are written by hand: what changed, who is affected, what to do.
- Every release states the theme contract it implements, the release line of the other repository it was tested with, and the minimum Node and PostgreSQL versions.

### Deprecation and support

- Something is deprecated in a MINOR: in the release notes, in the documentation, and with a warning at boot or build that names the replacement. It keeps working for at least one more MINOR and is removed only in a MAJOR (before 1.0.0, in a later `0.y`).
- Only the latest release line receives fixes, security fixes included.
- Within a MAJOR an upgrade runs its migrations on boot with no manual step. Going back across a MINOR is not supported: back up before upgrading.

## 8. Tests

- Every change of behaviour comes with a test at the lowest level that can catch it. A bug fix starts with the test that fails.
- Levels, from cheapest to most expensive: unit (pure helpers), component, integration (a real build, a real Strapi on SQLite), end to end (Playwright), contract (theme checks, visual regression, axe) and performance budgets. `AGENTS.md` lists the commands of each repository.
- Prefer the real thing to a mock. The CMS suites boot a real Strapi; the frontend replaces Strapi only at the HTTP boundary, with one shared mock server.
- What the two repositories promise each other is tested against the real thing: a contract suite runs the frontend against a real CMS, in the CI of both repositories. A change that breaks the other side fails before it merges.
- A mock is checked against what it replaces: the frontend's mock of the CMS is generated from the CMS's schemas or verified against a real instance.
- Tests are deterministic: no call to a real external service, no fixed sleeps, no dependence on order, clock or timezone.
- New fixtures use neutral data and reserved domains (`example.com`, `*.test`).
- Thresholds, budgets and visual baselines are floors. They are never lowered or regenerated to make a pull request pass; a justified change is its own pull request with the reason and the new numbers. Visual baselines come from the CI artifact, not from a local machine.
- A test that fails once is neither ignored nor retried until green: rerun it alone, compare with `main`, and write the outcome in the pull request.

## 9. Security, privacy, accessibility, performance and sustainability

### Security

- Validate every input at the boundary with a schema, on the server, whatever the client already checked.
- Least privilege: tokens are custom with exactly the permissions listed in the security document; nothing becomes public by accident. A change of permissions comes with tests of who can and who cannot.
- HTML built from content is sanitized on the server. `v-html` renders only sanitized output, with the reason on the line.
- The Content Security Policy is built from hashes. A new inline script, embed or media origin is probed on a production build before merging.
- Anything that writes, authenticates or sends email is rate limited.
- A security fix is its own pull request with the `security` scope. Vulnerabilities are reported privately, as the organisation's security policy says; each repository's `docs/security.md` gives its scope.
- Security review follows the OWASP Application Security Verification Standard: level 2 for authentication, sessions, access control and input handling, level 1 for the rest. Each repository's security document maps the requirements that apply to where they are enforced and tested.
- A site serves `/.well-known/security.txt` (RFC 9116) when its owner has set a security contact, and nothing otherwise.

### Privacy

- Pages make no request to a third party: fonts, analytics, embeds and scripts are self-hosted or proxied.
- Collect the minimum of personal data, keep it out of logs, and key by a hash when an identifier is only needed for counting or limiting.

### Accessibility

- The target is WCAG 2.2, level AA.
- Semantic HTML first; ARIA only where HTML has no element for the job. Everything works with the keyboard and has a visible focus.
- `prefers-reduced-motion` is honoured. Every heavy island has a static alternative.
- The contrast matrix of `theme:check` and the axe run (the WCAG 2.0, 2.1 and 2.2 rules of levels A and AA) pass with no exclusions.
- Automated rules find only part of the problems. A theme is admitted with a manual check recorded in its report: keyboard only, a screen reader, 200 % zoom and reflow at 320 px, reduced motion and forced colors.

### Performance

- Every page type has a budget, measured in CI for every installed theme and site mode. A change that moves a budget records the number and the reason in `docs/performance.md`.

### Sustainability

- Micelio follows the W3C Web Sustainability Guidelines where they apply to a site engine: less data transferred, no work the visitor did not ask for, static output whenever the content allows it.
- The performance report estimates the emissions of each page type from the bytes it transfers, next to its weight. The estimate becomes a budget once it has a baseline.

## 10. Dependencies, licences, supply chain and runtime

- A new production dependency **must** be justified in the pull request: what it replaces, what it weighs, its licence and who maintains it. Prefer the platform (principle 5).
- Licences are checked against the allowlist (`npm run lint:licenses`, shipped with the shared configuration packages). Third-party material keeps its licence file next to it, is listed in `THIRD-PARTY.md` and annotated in `REUSE.toml`.
- The licence policy (ADR 0007: AGPL-3.0-only, the theme exception, the DCO) and the allowlist are Micelio's. They bind the repositories of section 1 and nothing else in the organisation.
- The lockfile is committed and never edited by hand. CI installs with `npm ci`.
- Pin exactly what breaks on minor versions (0.x packages, WASM runtimes); use ranges for the rest.
- Dependabot proposes grouped minor and patch updates weekly. A major upgrade is done by hand, in its own pull request, with the full suite.
- An alert that cannot be fixed yet is written down with the reason the risk is accepted.
- GitHub Actions are pinned by commit SHA, with the version in a comment.
- Every published artifact (an image, a theme package) carries a software bill of materials and a signed build provenance attestation, and the operator documentation says how to verify them.
- The OpenSSF Scorecard runs on every repository. A finding is fixed or written down with the reason, like a dependency alert.
- All repositories run the same Node major. `.nvmrc` is the source: CI reads it, and `engines` and `@types/node` match it.

## 11. Git, pull requests and review

### Branches and commits

- Branch from the latest `main` as `<type>/<short-topic>`. Never commit on `main`.
- Commits and pull request titles start with a conventional prefix: `feat`, `fix`, `docs`, `refactor`, `style`, `test`, `ci`, `perf` or `chore`, with an optional scope (`fix(newsletter): …`). Use the `security` scope for security fixes and `chore(deps)` for dependencies. A `!` marks a breaking change (section 7). The title decides the section of the release notes and the version bump.
- The subject says what changes, in the imperative, in about 72 characters. The body gives the problem, then what changed, then what the reviewer must know.
- Every commit is signed off (`git commit -s`), certifying the Developer Certificate of Origin.

### Pull requests

- One concern per pull request. Refactors, dependency updates, security fixes and documentation travel separately from features.
- A pull request **should** stay under about 400 changed lines, not counting generated files and snapshots. A larger one is split or explains why it cannot be.
- The description follows the template: Problem, What changes, For review, Tests and Instructions that were wrong or missing (section 13).
- It references its issue: `Refs #N` while work remains, `Closes #N` in the last one. The issue's Progress section is updated in the same step.
- `npm run check` passes locally before the pull request is opened. CI is the gate; a red check is never merged around.

### Review

- Every pull request is read in full by someone other than whoever wrote it. For a change written by an agent, the human who opens the pull request has read the whole diff and answers for it. Before the human reads, the change has passed the review and the verification of section 13.
- For a pull request written by an agent, the risk sets the order in which the human reads, never what is read. A pull request that touches a contract of section 6, security or permissions, or a migration, or that carries a `!`, is read from the diff first and then the reports of the reviewer and the verifier. Any other pull request is read from those reports and the description first, then the diff. The whole diff is read in both cases. The approval, or a review comment where GitHub allows no approval, records which order was used and the minutes it took (`time: <minutes>m diff|report`).
- Findings are **Blocking**, **Important** or **Suggestion**, each with `path:line` and a concrete fix.
- The reviewer checks, in order: correctness and edge cases; contracts and the version bump (sections 6 and 7); security and permissions; tests that would fail without the change; documentation the change made false; scope.

### Done

A change is done when all of these are true:

- The required checks are green and the description gives their real numbers.
- New behaviour has tests, and both locales have the new strings.
- New and changed exports have their TSDoc comment.
- The documents the change made false are updated in the same pull request: `docs/`, README, `AGENTS.md`, skills.
- A contract change follows sections 6 and 7, and an expensive decision has its ADR.
- The issue's Progress section says what changed and what remains.

## 12. Documentation, decisions and planning

### Organised by reader

Documentation is source: Markdown in the repository, changed in the same pull request as the code and tagged with it. `docs/` is organised by who reads it, and a new document goes in its reader's folder.

| Reader | Needs | Lives in |
| --- | --- | --- |
| Someone deciding whether to use Micelio | What it is and the shortest path to a running site | `README.md` |
| Site operator | Install, configure, upgrade, back up, every variable | `docs/operate/`, `.env.example`, release notes |
| Site editor | How to build pages and publish content in the CMS | `docs/guide/` |
| Theme creator | The guide, the contract reference, the contract changelog | `docs/themes/` |
| Integrator | Routes, inputs, outputs, errors; caching and behaviour | `docs/openapi.json` (generated), `docs/api.md` |
| Contributor, human or agent | Rules, structure, procedures, how a subsystem works | This standard, `AGENTS.md`, skills, `docs/architecture/` |
| Whoever asks "why is it like this?" | The decision, the options and the cost | `docs/adr/` |

- A document is one of four kinds and does not mix them: a tutorial (learn by doing), a how-to (reach one goal), a reference (look something up) or an explanation (understand why).
- Reference is generated from its source of truth whenever one exists, and lint fails when it drifts, as the theme schema and reference already do. For code, the source of truth is the TSDoc comment (section 4).
- How one site is deployed or designed is that site's documentation and lives in that site's repository, not in the core (principle 2).
- Documentation for operators, editors and theme creators may be translated. English is the source, and a translation says which version it follows.

### Outside the repository

- The documentation site is built from `docs/` at each release tag, one version per release line. Nothing is written directly on the site.
- GitHub releases hold the release notes. Issues and milestones hold the plan. Discussions hold questions: an answer given twice becomes documentation.
- No wiki. Nothing normative lives only in an issue, a chat or a blog post: a decision reached there is written into `docs/` or an ADR before the issue closes.

### Decisions and planning

- An ADR is written for a decision that is expensive to undo: caching, authentication, data model, a public contract, licensing, security headers, deployment, versioning. Records are never rewritten; a new record supersedes the old one. Decisions about the product that span repositories are recorded in `micelio`; decisions about this standard and the shared tooling in `micelio-engineering`; the other repositories link to them.
- An issue is opened from a template (`.github/ISSUE_TEMPLATE/`): a bug, a proposal, a task or an epic. Bugs and proposals are how anyone reports; tasks and epics are the plan, written by maintainers and agents.
- A task is titled with the conventional prefix its pull request will carry and has five parts: Why, What to build, Requirements (the contracts and behaviour that must not break, and the version bump), Acceptance criteria (a checklist where every line can be verified by a test or a command) and Progress.
- An epic lists its issues by phase with their dependencies, and says which can start now. Its Progress section and its checkboxes are updated by every pull request that advances it.
- A milestone is named `<Product> · <Outcome>` and its description ends with a sentence that starts "Done when".
- An issue is specific enough that an agent with no other context can start from it: it names the files, commands and documents it knows about, and says what is out of scope.

## 13. Coding agents

Agents follow everything above. They are also held to these rules:

- **Read first.** Before changing code: `AGENTS.md`, the sections of the standard the role's prompt names, the skill that matches the task, the issue and the ADRs of the area.
- **Start from a ready issue.** A worker starts only from an issue that passes `lint-issue`, the Definition of Ready of `micelio-engineering`. An issue that fails goes back to whoever wrote it; the worker does not complete it.
- **Hard limits.** Never push, merge, tag, release or deploy, and never act on production or staging, without the approval of the human running the session. Never read or print secrets. `.claude/TEAM.md` has each repository's list.
- **Never weaken a check to get green.** No skipped or deleted tests, no lowered thresholds or budgets, no regenerated baselines, no broad suppressions. If a check is wrong, say so and stop.
- **Stay in scope.** Report an unrelated problem instead of fixing it.
- **Report evidence.** The commands that were run, their real results, and what could not be verified.
- **Review and verify by others.** A pull request written by an agent is reviewed by an agent that did not write it and has none of the author's context, and verified by a third that re-creates the repository's Docker (or the run `AGENTS.md` names instead) from a clean copy and runs the commands of the description again, before a human reads it (section 11). The verifier has not read the review. A Blocking finding is fixed. An Important one is fixed or justified in the answers to the review, which the verifier does not read, and the master decides whether the justification stands. A Suggestion needs no answer.
- **Name the instructions that failed.** The description has a section "Instructions that were wrong or missing": what in `AGENTS.md`, a skill or the issue failed the agent. "Nothing" is a valid answer; an absent section is not.
- **Attribution.** A commit with agent-written content carries a `Co-Authored-By:` trailer that names the tool. The `Signed-off-by` line belongs to the human who reviewed the change: the DCO is a person's certification, and an agent cannot give it.
- **Keep the instructions true.** When `AGENTS.md` or a skill of the repository turns out to be wrong or out of date, correcting it is part of the task, in the same pull request. This standard, and the other files that are synced from `micelio-engineering` (`docs/standard-sync.md` of `micelio-engineering` lists them: https://github.com/bogd3v/micelio-engineering/blob/main/docs/standard-sync.md), are not corrected in another repository: the copy is checked by `lint:standard` and the next sync puts it back (section 16). The agent reports them in the description, and the maintainer opens a `docs(standard)` issue in `micelio-engineering` (a `chore(factory)` issue for a synced file other than the standard).
- **Turn repetition into tooling.** A procedure done twice becomes a skill. A correction given twice becomes a check.
- **Log the corrections.** Every time work is sent back by the human, the reviewer or the verifier, the correction is logged with its category. At each milestone's retro the corrections that repeat are converted into a check, a skill or a rule, and each logged correction ends the retro with a destination.

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

- Propose the change as a pull request to the canonical copy, titled `docs(standard): …`, with the reason. Raise the version and add a line to the table below.
- When the new version is released, the Micelio bot (the organisation's GitHub App) opens a `docs(standard): sync to X.Y` pull request in every repository of section 1 that replaces the local copy and the version pinned in `AGENTS.md`. A human reviews and merges it; the bot never merges. Until that workflow exists (bogd3v/micelio-engineering#5), the copy is made by hand in a pull request that references the first one.
- `npm run lint:standard` fails when the local copy does not match the version pinned in `AGENTS.md`. A repository may stay on an older version on purpose; the lint checks the pinned one.
- An exception for one repository or one case is an ADR in that repository, not an edit here.

| Version | Date | Change |
| --- | --- | --- |
| 1.0 | 2026-10-08 | First version, written from the conventions of `micelio` and `micelio-cms` |
| 1.1 | 2026-10-09 | Contract tests between repositories, OWASP ASVS, problem details and OpenAPI, SBOM and provenance, `security.txt`, WCAG 2.2 with a manual check, sustainability, and the community documents |
| 1.2 | 2026-10-15 | Before 1.0.0 the project is alpha: breaking changes need no deprecation period and no ADR, only the `!`, a `BREAKING CHANGE:` paragraph and upgrade notes |
| 1.3 | 2026-10-18 | The Integrator row of section 12 names the generated OpenAPI document as the reference of routes, inputs, outputs and errors, and `docs/api.md` for caching and behaviour |
| 1.4 | 2026-10-20 | Scoped to Micelio's repositories, with the Strapi plugins and the tooling among them; the canonical copy moves to `micelio-engineering` and local copies are synced by the Micelio bot and checked by `lint:standard`; the code of conduct and the security policy come from the organisation, contribution terms, governance and trademarks from `micelio-engineering`; contracts for blocks, plugin hooks, editorial states and the site export, keyed by site; plugin and configuration packages in the versioning rules; the licence policy stated as Micelio's; the plugin checklist in section 14 |
| 1.5 | 2026-10-22 | Section 9 points vulnerability reports to the organisation's security policy, with each repository's scope in its `docs/security.md`, instead of a `SECURITY.md` per repository |
| 1.6 | 2026-11-03 | The rules of the factory: section 13 gains the ready issue, review and verification by other agents, the section on wrong instructions, and the correction log and retro; "Keep the instructions true" no longer sends a wrong standard or synced file to be fixed outside `micelio-engineering`; section 11 gains the review order by risk; section 7 says where the rule is that before 1.0.0 `feat` raises `z`, and that a feature that adds a refusal or a boot failure is breaking |
| 1.7 | 2026-11-04 | `CLAUDE.md` no longer imports the standard: it imports `AGENTS.md` and `.claude/TEAM.md`, and each role reads the sections of the standard its prompt names (section 1; section 13, "Read first"); `CLAUDE.md` travels with the sync. No rule is relaxed: only how the standard is loaded changes |
