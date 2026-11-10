# Configure the fediverse plugin

**Kind:** how-to. For the operator of a Strapi host that installs `@micelio/strapi-plugin-fediverse`: what the host must provide, every variable, how to enable federation on a running site and what to check afterwards. How the plugin works is in [architecture/federation.md](../architecture/federation.md); the public routes are in [api.md](../api.md).

The plugin is **off by default**. A host turns it on from its `config/plugins.ts` with `FEDIVERSE_ENABLED=true` (the master switch the host reads, as `test/app/config/plugins.js` does for the suites). Off, the plugin is not loaded: no fediverse routes, content types or publish hooks exist.

## What the host provides

The plugin reads and writes content types it does not own, and it never imports from a host's `src/`. A host that installs it provides:

- **The plugins it builds on**: `@micelio/strapi-plugin-core` (the default site, `plugin::micelio.site`, where the actor's profile and the object type are edited), `strapi-plugin-comments` (fediverse replies are stored as comments), Strapi's `i18n` and users-permissions.
- **The content types it reads**: `api::article.article` (`title`, `slug`, `description`, `cover`, `coverCredit`, `seo`, `category`, `tags`) and the single type `api::global.global` (`siteName`, `siteDescription`, `favicon`, the avatar of the actor).
- **The comments extension**: a `strapi-server` extension of `strapi-plugin-comments` (`src/extensions/comments/strapi-server.ts` in `bogd3v/micelio-cms`, `test/app/src/extensions/comments/strapi-server.js` in this repository) that adds the attributes the plugin writes: `fediverseUri` (the remote note id, unique) and `fediverseActorHandle` (`@user@host`, or `null`) for ingested replies, and `fediverseNoteUri` and `fediverseNoteRetracted` for a moderator's reply. It is a server extension, not an extension `schema.json`: Strapi merges schema files shallowly, and a `schema.json` that declared `attributes` would replace every attribute of the comments plugin.
- **The middlewares that hide what must not be public**: one that prunes `PENDING` and `REJECTED` comments and their subtrees from `GET /api/comments/*` (the plugin stores every fediverse reply as `PENDING`, and the comments plugin's public API returns every comment), and one that gives back the public fediverse fields (`fediverseUri`, `fediverseActorHandle`) that the comments plugin's response schema drops, never the non-public `fediverseNoteUri` and `fediverseNoteRetracted`. Without the first, remote spam is public the moment it arrives. They belong to the host so they keep protecting readers while the plugin is off (`test/app/src/middlewares/` has the minimal pair).
- **`proxy: { koa: true }`** in `config/server`. Behind a TLS-terminating proxy, Koa must trust it, or every ActivityPub id is generated with `http://`.
- **A persistent store.** Followers, the actor key pair, the record of federated articles and, on PostgreSQL, the deliveries waiting to be sent live in the database. If it is wiped, the next boot generates a new actor key and every follower is lost. Each site's rows and key live in it.
- **`ENCRYPTION_KEY`**, Strapi's own (`admin.secrets.encryptionKey`): the actor's private key is stored encrypted with it, and so are the queued deliveries. See [security/keys.md](../security/keys.md).
- **The admin registration.** The panel in the article edit view and the Fediverse page are registered from the host's root admin app (`registerFederationPanel` and `registerFediversePage` of `admin/src/index.ts`; `src/admin/app.tsx` in `bogd3v/micelio-cms`), because Strapi bundles a local plugin's admin code only when the plugin is enabled while the admin is built. This package does not build or export its admin code yet: how a host receives it is decided by the issues that follow the move.
- **Optionally, a request guard** for rate limiting: a function registered as `plugin::fediverse.requestGuard` in the config, called on federation paths before Fedify reads the request ([architecture/federation.md](../architecture/federation.md#hosting-in-strapi)).

## Environment variables

`.env.example` lists the names with a safe example value; this table says what each does.

| Variable                          | Default                                                       | Purpose                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEDIVERSE_ENABLED`               | `false`                                                       | Master switch (enable explicitly, e.g. staging before prod)                                                                                                                                                                                                                                              |
| `URL` _(Strapi's own)_            | `http://localhost:1337`                                       | **Must be the public origin** (e.g. `https://cms.example.com`). Fan-out runs outside any request and builds every activity id from it; a wrong value makes ids disagree with the ones served over HTTP                                                                                                   |
| `FEDIVERSE_HANDLE_HOST`           | _(unset: the host of `URL`)_                                  | Host of the handle (`@blog@example.com`) when it is not the CMS host (bogd3v/micelio-cms#298). Needs `URL`; the boot stops on a value that is not a bare host. See [A handle on the site's domain](#a-handle-on-the-sites-domain-fediverse_handle_host). Also listed in the actor's `attributionDomains` |
| `FEDIVERSE_ACTOR_USERNAME`        | _(unset)_                                                     | **Removed** (bogd3v/micelio-cms#307): a boot with it set stops, naming the site settings' `fediverse.username`. The handle's `@user` is that setting, else the identifier                                                                                                                                |
| `FEDIVERSE_ACTOR_IDENTIFIER`      | _(required)_                                                  | Path of the actor URI (`/fediverse/user/blog`). Never change it: remote servers key the account and its followers by that URI                                                                                                                                                                            |
| `FEDIVERSE_ACTOR_NAME`            | _(unset)_                                                     | **Removed** (bogd3v/micelio-cms#307): a boot with it set stops, naming `fediverse.displayName`                                                                                                                                                                                                           |
| `FEDIVERSE_ACTOR_SUMMARY`         | _(unset)_                                                     | **Removed** (bogd3v/micelio-cms#307): a boot with it set stops, naming `fediverse.summary`                                                                                                                                                                                                               |
| `FEDIVERSE_ACTOR_SOURCE_URL`      | _(unset)_                                                     | **Removed** (bogd3v/micelio-cms#307): a boot with it set stops, naming `fediverse.sourceUrl`; the "Código" link is that setting, else `https://github.com/bogd3v/micelio-cms`                                                                                                                            |
| `FRONTEND_URL`                    | _(required in production)_; `http://localhost:3000` otherwise | Human-facing `url` embedded in federated `Article` objects. Without it in production the plugin refuses to start. Its host is also the actor's `attributionDomains` ([Author credit on Mastodon link cards](#author-credit-on-mastodon-link-cards))                                                      |
| `FRONTEND_ARTICLE_PATH`           | `/blog/{slug}`                                                | Article URL pattern (confirmed against the frontend repo: default locale, `prefix_except_default`)                                                                                                                                                                                                       |
| `FRONTEND_DEFAULT_LOCALE`         | `en`                                                          | Locale the frontend serves without a URL prefix (Nuxt `prefix_except_default`); articles in any other locale get `/<locale>` in their link, e.g. `https://example.com/es/blog/{slug}`                                                                                                                    |
| `ENCRYPTION_KEY` _(Strapi's own)_ | _(required)_                                                  | Encrypts the actor's private key at rest and the key inside queued deliveries. Changing it makes the stored key unreadable: federation then fails closed until the old value is back ([security/keys.md](../security/keys.md#rotating-encryption_key))                                                   |

The four `FEDIVERSE_ACTOR_*` variables marked **removed** are not read. A boot with federation on and one of them set (not blank) stops, naming the setting that replaces it (`server/src/utils/removed-variables.ts`); move the value into the site settings first, then delete the variable. With `FEDIVERSE_ENABLED=false` the plugin is not loaded and nothing is checked. While enabled, `FEDIVERSE_ACTOR_IDENTIFIER` has no default: without it the plugin refuses to start.

## The profile is edited in the admin panel

The actor's profile is edited in the admin panel, not in the environment: Content Manager → Sites → the entry marked default → **Fediverse profile** has the username (the handle's `@user`, lowercase letters, digits and `_`; changing it keeps the followers, and the identifier keeps resolving, but the previous username does not), the display name, a summary of up to 500 characters (plain text), a header image (1500×500 recommended; the size is not checked), whether the account is discoverable (on by default) and the source URL shown in the "Código" field. **Object type** chooses what articles are sent as: `Note` (the default: a regular post with the title, excerpt and link, the shape Ghost and WriteFreely use, which GoToSocial shows without hiding it behind the title) or `Article` (shown by Mastodon as a title and a shortened link). Switching sends nothing and keeps every link and id: posts already sent keep their type until their next edit. Saving the profile sends an `Update(Person)` to the followers' servers. An empty field uses the site's identity: the display name and the summary are Global's name and description, then the default site's name and description. With none of them the handle is the identifier and there is no bio. The order of each field is in [architecture/federation.md](../architecture/federation.md#actor-profile-in-the-site-settings).

## Author credit on Mastodon link cards

The actor lists the host of `FRONTEND_URL`, and `FEDIVERSE_HANDLE_HOST` when set, in its `attributionDomains`, so Mastodon shows the blog's account on the card of a shared article. It works only when the site's canonical URL (the site settings' URL, or the frontend's `NUXT_PUBLIC_SITE_URL`) is on one of those hosts or a subdomain of them. A restart that changes them sends an `Update(Person)` to the followers. Details and how to check it: [architecture/federation.md](../architecture/federation.md#author-attribution).

## A handle on the site's domain (`FEDIVERSE_HANDLE_HOST`)

By default the handle is `@blog@cms.example.com`, the host of `URL`, because the actor lives on the CMS. To show `@blog@example.com` instead, set `FEDIVERSE_HANDLE_HOST=example.com` and make the site domain forward WebFinger to the CMS. Every id stays on the CMS origin (the actor, its inbox, outbox and key ids do not change), so no follower is lost.

1. Set `URL` to the CMS's public origin. It is required with this variable: the boot stops with a message naming the variable if `URL` is missing, or if the value is not a bare host such as `example.com`.
2. Forward `/.well-known/webfinger` on the site domain to the CMS. The frontend route that does it comes later; until then a proxy rule does:

   ```caddyfile
   example.com {
       handle /.well-known/webfinger {
           reverse_proxy https://cms.example.com {
               header_up Host {upstream_hostport}
           }
       }
       # the rest of the site as before
   }
   ```

   ```yaml
   # Traefik, dynamic configuration: a router on the site domain, with a higher priority than the site's
   http:
     routers:
       webfinger:
         rule: 'Host(`example.com`) && Path(`/.well-known/webfinger`)'
         priority: 100
         service: cms
         tls: {}
     services:
       cms:
         loadBalancer:
           passHostHeader: false
           servers:
             - url: 'https://cms.example.com'
   ```

3. Check it from outside: `npx @fedify/cli lookup @blog@example.com`.

Once set, **only the handle host resolves**: `@blog@cms.example.com` stops answering WebFinger, so searching for it finds nothing. Servers that already follow the site keep doing so, because they key the follow by the actor id. Details and the reason: [architecture/federation.md](../architecture/federation.md#changing-the-handle-without-losing-followers).

`URL` must be the CMS's real public origin, because activities sent in the background build their ids from it. Requirements that are easy to miss:

- **Node 22.19 or later.** Strapi 5.59 depends on undici 8, which needs that version, and it also covers Fedify, whose ESM-only package `require()` loads from Node 22.12. The package declares `node >=22.19.0` in `engines`; do not run a host image on an older Node.
- **A persistent database.** Followers, the actor's key pair, the record of federated articles and, on PostgreSQL, the deliveries waiting to be sent live in the database. If it is wiped, the next boot generates a new actor key and every follower is lost.
- **Proxy headers.** Behind a TLS-terminating proxy, generated URLs use `https` only if Koa trusts the proxy (`proxy: { koa: true }`, [What the host provides](#what-the-host-provides)) and the proxy forwards `X-Forwarded-Proto` and `X-Forwarded-Host`; how a host decides which proxies it trusts is the host's (for `bogd3v/micelio-cms`, `TRUST_PROXY` and `TRUST_PROXY_PROTOCOL` in its `docs/operate/configure.md`). Federation does not depend on those headers when `URL` is set: every actor, inbox, key and WebFinger id is built from the origin of `URL`, so a forged `X-Forwarded-Host` cannot make the actor document name another host. Set `URL` to the real public origin in production; unset, the ids follow the request.
- **No proxy or DNS changes.** Fedify's routes (`/.well-known/webfinger`, `/nodeinfo/2.1`, `/fediverse/*`) are served by the CMS on the same domain as the API.

## Enable it on a running site

1. Take a database backup (the host's backup procedure; for `bogd3v/micelio-cms`, its `docs/operate/backup.md`). On the first boot with the plugin enabled the CMS creates `fediverse_followers`, `fediverse_interactions` and `fediverse_federated_articles` and adds `fediverse_uri` and `fediverse_actor_handle` to the comments table.
2. Set `FEDIVERSE_ENABLED=true` and `FEDIVERSE_ACTOR_IDENTIFIER`, and restart.
3. Verify from outside:
   ```bash
   curl -s https://cms.example.com/_health -o /dev/null -w '%{http_code}\n'   # 204
   npx @fedify/cli webfinger @blog@cms.example.com                            # 200, https links
   npx @fedify/cli lookup @blog@cms.example.com                               # actor with inbox, outbox, publicKey
   ```
4. Follow the actor from a Mastodon account, publish an article, and watch the logs for `[fediverse]` lines (each fan-out reports how many followers it was queued for).

## Upgrading to 0.7: the federation state belongs to a site

**This is a breaking change of stored data.** The followers, interactions and federated-article rows, and the actor key, belong to a site now (ADR-0017, section 4), and the plugin needs `@micelio/strapi-plugin-core` 0.2 or later, which owns the sites. Nothing is lost and nothing changes for remote servers: the actor id, the key id and the messages in the delivery queue are the same, and `fedify_kv_v2` and `fedify_message_v2` are not touched.

1. Take a database backup (the host's procedure).
2. Install the new version and restart. On the first boot, once the core has created the default site (it has since its 0.6), the plugin gives it every follower, interaction and federated-article row that has no site, and copies the stored actor key to the default site's entry. It logs counts only, for example `[fediverse] gave the default site 120 follower(s), 340 interaction(s), 85 federated article(s) and 1 actor key(s)`. A second boot logs nothing and changes nothing. On a database that has no site yet, the same happens as soon as the core creates the default site.
3. Check that **Fediverse** lists the followers it listed before, and that the actor document is the same (apart from timestamps).

**Rollback:** the key stays under its old name in the store (`keyPairs`) for one release line, so the previous version finds it. The `site` column of the rows stays in the tables; the previous version ignores it.

With more than one site, each has its own followers, interactions, federation state and actor key. This release serves the default site's actor; the Fediverse page and the panel of an article take `?site=<slug>` to show another site's state ([api.md](../api.md#which-site)).

## Move the article to the editorial workflow without a double send

The plugin federates an article from one trigger, chosen by the content type:

- `api::article.article` **without** the `editorial` component: the Document Service events `entry.publish` and `entry.unpublish` on `strapi.eventHub`.
- `api::article.article` **made with `withEditorial`** of `@micelio/strapi-plugin-core`: the core's `afterPublish` and `afterUnpublish` hooks, which fire when an article moves through `POST /micelio/transitions`. The plugin ignores `entry.publish` and `entry.unpublish` for that type.
- `entry.delete` is listened to for both: the hooks have no delete.

The plugin reads which one applies from the type's schema at each event, so there is no variable to set. To move the article, in the host:

1. Wrap the schema: `withSiteScope(withEditorial(schema))` (a `schema.js` or `schema.ts` in `content-types/article/`; `test/app/src/api/article/content-types/article/schema.js` in this repository is an example). The order of the update does not matter: a version of the plugin without the hooks still federates the editorial article from `entry.publish` and `entry.unpublish`, because the core's transitions publish with the Document Service, but for the default site only; it does not use the site of the entry.
2. Publish and unpublish from then on only with the transitions (`in_review → published`, `published → published` to put an edit live, `published → draft` to take it down). The core refuses any other route for that type, the Content Manager included, so nothing publishes through the event hub.
3. An article is sent once either way: do not call `federateArticle`, or publish through the Document Service in a script, as a second trigger.

A `Create`, `Update` or `Delete` is the same whichever trigger sends it, and publishing returns once the activity is queued: the article's state says `created`, `updated` or `deleted`, never "delivered" ([architecture/federation.md](../architecture/federation.md#delivery-retries-and-what-the-row-says)).

## Fediverse page

The admin menu has a **Fediverse** entry (diagnostics, followers, failed deliveries). It appears only for a role that has the permission **Read the Fediverse page** (`plugin::fediverse.read`); blocking, unblocking and retrying need **Block and unblock followers, and retry failed deliveries** (`plugin::fediverse.manage`). The super admin has both. Give them to the other roles in Settings → Administration Panel → Roles, under Plugins. They exist only while `FEDIVERSE_ENABLED=true`, so with federation off nobody sees the entry. **Turning federation off and on again removes the grants:** Strapi deletes the permissions of an action that is not registered from every role at boot, so after enabling it again only the super admin has them and the other roles must be given them again. Opening the page makes the CMS request its own WebFinger address (`URL`), once per visit.

What each failing diagnostic means and how to fix it:

- **Public address, `url-missing`:** set `URL` to the CMS's real public origin (for example `https://cms.example.com`) and restart.
- **Public address, `url-not-https`:** `URL` should be the public `https` origin; behind a TLS-terminating proxy, set it to the `https` address and make the proxy forward `X-Forwarded-Proto`.
- **Actor key, `actor-key-missing-encryption-key`:** `ENCRYPTION_KEY` is not the value the key was encrypted with. Put the previous value back and restart; the stored key is not touched.
- **Actor key, `actor-key-missing`:** no key is stored yet. It is created the first time a remote server fetches the actor or an activity is sent; fetch the actor's address once, or publish an article. If followers already exist, the key was lost: restore the database from a backup. The page only reads the key, it never creates it.
- **Actor key, `actor-key-unreadable`:** restore the database from a backup taken before the problem; a new key would be a new identity for every follower.
- **WebFinger, `webfinger-skipped`:** needs `URL`.
- **WebFinger, `webfinger-unreachable`:** the CMS cannot reach its own public address: check DNS, the proxy and the firewall.
- **WebFinger, `webfinger-not-found`:** the address answers, but not with the WebFinger document: make sure `/.well-known/*` and `/fediverse/*` reach the CMS.
- **WebFinger, `webfinger-wrong-subject`:** check the username in the default site's Fediverse profile and that the domain of `URL` is the CMS's.

## Delivery queue and database connections

Publishing returns as soon as the activities are queued; the CMS delivers them in the background and retries a failure with Fedify's default backoff (up to 10 retries over roughly 20 to 35 minutes; a host that keeps failing is then held by Fedify's circuit breaker for up to a week). There is no variable for it: the backend follows `DATABASE_URL`.

- **PostgreSQL (production).** The queue and Fedify's cache are two tables, `fedify_message_v2` and `fedify_kv_v2`, created on first use in the schema the CMS uses (`DATABASE_SCHEMA`). A restart loses none of the deliveries waiting in it; the one being sent at the moment of a crash is lost. They use their own pool, apart from Strapi's: **at most 3 connections plus 1 that listens for new messages, so 4 more per CMS process**. Count them in `max_connections` (a managed database with a small limit, or a pooler in transaction mode, is where this shows up). The constant is `FEDIFY_POOL_SIZE` in `server/src/constants/queue.ts`. The queued activities hold the actor's signing key, encrypted with `ENCRYPTION_KEY` (change that value and what is waiting in the queue is dropped); the pool checks the database certificate for the `sslmode`s that Strapi's `pg` checks; a backup of these tables is as sensitive as one of the key itself.
- **SQLite (development, tests).** The queue is in memory: a restart loses what was waiting.
- **Reading the state.** The edit view of an article has a **Fediverse** panel in its side column: the state of the last activity, the counts, and a **Federate now** button that needs the permission to publish articles. Each article's `Fediverse Federated Article` entry in the admin panel says when its last activity was queued, how many attempts it has had and the last error; `failed` means at least one follower's server was given up on. Nothing says an activity was _delivered_: Fedify does not report it. A follower whose server answered `404` or `410` is skipped by later publishes until it sends the blog an activity again.

**Rollback:** set `FEDIVERSE_ENABLED=false` and restart. The routes and hooks disappear; the tables, followers and key pair stay in the database, and the comments-visibility middleware keeps hiding pending comments. Remote servers that still know the actor get 404s until it is enabled again.
