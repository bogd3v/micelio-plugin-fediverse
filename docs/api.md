# Public routes

**Kind:** reference. For an integrator, usually a frontend: the routes the plugin adds that anyone can call, and the federation endpoints that remote servers call. Why they behave as they do is in [architecture/federation.md](architecture/federation.md).

The plugin is on only when the host enables it (`FEDIVERSE_ENABLED=true`, [operate/configure.md](operate/configure.md)). Switched off, none of the routes below exists.

## Custom public routes

All `auth: false`, aggregates only (never who interacted), and absent when `FEDIVERSE_ENABLED=false`. They are Strapi content API routes of the plugin (`server/src/routes/index.ts`, `server/src/controllers/stats.ts`), served under `/api/fediverse`, outside the paths Fedify handles.

- `GET /api/fediverse/articles/:documentId/stats` → `{ likes: number, boosts: number }`, 404 for unpublished or unknown articles.
- `GET /api/fediverse/articles/stats?documentIds=a,b,c` (at most 50, else 400) → `{ [documentId]: { likes, boosts, replies } }`. Only articles published in the default locale are included; other ids are left out. `Cache-Control: public, max-age=60`.
- `GET /api/fediverse/articles/ranking?page=1&pageSize=6&locale=es&category=ia&tag=vue&search=rag` → `{ data: [{ documentId, likes, boosts, replies }], meta: { pagination: { page, pageSize, pageCount, total } } }`. Articles published in `locale` (default locale if omitted), ordered by `likes + boosts + replies` desc, then `publishedAt` desc; articles with no interactions come last so paging covers the whole blog. `pageSize` defaults to 6, max 50. Optional filters narrow the list before ranking, so pages match the blog filters: `category` (category slug), `tag` (tag slug; combined with the others with AND) and `search` (title contains it, case-insensitive; `%` and `_` are plain text; ignored under 3 characters). `Cache-Control: public, max-age=60`. Bounds: `page` above 10 000 is clamped to 10 000; `search`, `category` or `tag` over 200 characters (UTF-16 code units) and a `locale` that is not configured in the i18n plugin answer 400; an empty `locale` counts as absent.

The outbox cursor (`/fediverse/user/<handle>/outbox?cursor=N`) is an offset and is clamped to 100 000.

`replies` counts approved comments with a `fediverseUri` (every fediverse reply has one, even when its actor handle could not be resolved) that are not removed or blocked. Blocked actors' likes, boosts and replies never count.

### Which site

The three routes belong to a site like every content API route of a Micelio plugin: `?site=<slug>` names it, else the host of the request does, else the default site (`docs/api.md` of `@micelio/strapi-plugin-core`, "Which site a request is for"), and a slug no site has answers `404` with the code `unknownSite`. They count only the interactions and the blocked actors of that site, so a frontend that names no site sees the default site's, as before the sites existed.

## Federation endpoints

Served by Fedify, outside Strapi's authentication and permissions, for remote servers rather than for a frontend. The actor path uses `FEDIVERSE_ACTOR_IDENTIFIER` (the examples say `blog`).

| Path                                     | What it answers                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `/.well-known/webfinger`                 | WebFinger of the handle (`acct:<username>@<handle host>`)                             |
| `/.well-known/nodeinfo`, `/nodeinfo/2.1` | NodeInfo with the software name and the count of published articles                   |
| `/fediverse/user/blog`                   | The actor (`Person`)                                                                  |
| `/fediverse/user/blog/inbox`             | The actor's inbox (`POST`, signed)                                                    |
| `/fediverse/inbox`                       | The shared inbox (`POST`, signed)                                                     |
| `/fediverse/user/blog/followers`         | The followers collection                                                              |
| `/fediverse/user/blog/outbox`            | The outbox: public `Create(Article)` activities, paginated by `cursor`                |
| `/fediverse/articles/:documentId`        | An article as an `Article` or a `Note` (`404` unless published in the default locale) |
| `/fediverse/notes/:documentId`           | A moderator's reply as a `Note` (`404` unless it is shown)                            |

The ids in this table are contracts that never change ([architecture/federation.md](architecture/federation.md#contracts-that-never-change)). An inbox `POST` that fails authentication is answered `401`; one refused for its `Digest` or `Signature-Input` is `401` as well, with a plain-text reason ([architecture/federation.md](architecture/federation.md#inbox-digest-algorithms)).

## Admin routes

The admin panel calls the routes under `/fediverse-panel`. They need an admin session and are not for integrators. Those of the Fediverse page and of an article's panel act for the default site, or for the site `?site=<slug>` names (a slug no site has answers `404`, code `unknown-site`); they are listed with their permissions in [architecture/federation.md](architecture/federation.md#article-panel) and [Plugin page](architecture/federation.md#plugin-page).
