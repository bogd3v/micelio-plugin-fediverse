import type { Core } from '@strapi/strapi'
import { withSiteScope } from '@micelio/strapi-plugin-core/strapi-server'

import federatedArticleSchema from './content-types/federated-article/schema.json'
import followerSchema from './content-types/follower/schema.json'
import interactionSchema from './content-types/interaction/schema.json'
import federation from './controllers/federation'
import pluginPage from './controllers/plugin-page'
import stats from './controllers/stats'
import routes from './routes'
import { assertActorConfigured } from './constants/actor'
import { mountFediverseMiddleware, startFederationQueue, stopFederation } from './federation'
import actorProfile from './services/actor-profile'
import { registerPermissionActions } from './services/permissions'
import defaultSiteService, {
  adoptDefaultSite,
  migrateStoredArticles,
  onSiteCreated,
} from './services/default-site'
import federatedArticles from './services/federated-articles'
import followers from './services/followers'
import interactions from './services/interactions'
import keys, { encryptStoredActorKeys } from './services/keys'
import lifecycle, { subscribe, unsubscribe } from './services/lifecycle'
import { subscribeReplies, unsubscribeReplies } from './services/reply-publisher'
import statsService from './services/stats'
import {
  subscribe as subscribePublisher,
  subscribeHooks as subscribePublisherHooks,
  syncProfileAtBoot,
  unsubscribe as unsubscribePublisher,
  unsubscribeHooks as unsubscribePublisherHooks,
} from './services/publisher'
import { configureFedifyLogging, resetFedifyLogging } from './utils/fedify-logging'
import { assertNoRemovedActorVariables } from './utils/removed-variables'
import { frontendBaseUrl } from './utils/frontend-url'
import { handleHost } from './utils/handle-host'

/** Removes the handler of the core's `siteCreated` hook. */
let stopSiteCreated: (() => void) | undefined

const plugin = {
  register({ strapi }: { strapi: Core.Strapi }): void {
    // Without an actor identity or a frontend URL the plugin would federate
    // under a made-up account or link to another site: refuse to start.
    // A variable the settings replaced would be ignored without a word: refuse to start instead.
    assertNoRemovedActorVariables()
    assertActorConfigured()
    frontendBaseUrl()
    // A handle host that is malformed or has no `URL` to keep the ids on stops the boot too.
    handleHost()

    // Mounted in register() on purpose: plugin register() runs before
    // server.initMiddlewares() (which mounts `strapi::body`), and the router
    // is only mounted at listen() time. This guarantees the Fedify middleware
    // sees the raw request stream (needed for HTTP signature verification on
    // inbox POSTs) and intercepts fediverse paths before they can 404.
    strapi.server.use(mountFediverseMiddleware(strapi))
    // Fedify reports refused signatures and failed fetches only through LogTape.
    configureFedifyLogging(strapi.log)
    // The core's `hooks` service exists from the start, whatever the order of the plugins.
    stopSiteCreated = strapi
      .plugin('micelio')
      .service('hooks')
      .on('siteCreated', (payload: { site: string; isDefault: boolean }) =>
        onSiteCreated(strapi, payload)
      )
    // Articles of the editorial workflow are federated from the hooks of the core (ADR-0017, section 5).
    subscribePublisherHooks(strapi)
  },

  async bootstrap({ strapi }: { strapi: Core.Strapi }): Promise<void> {
    subscribe(strapi)
    subscribePublisher(strapi)
    subscribeReplies(strapi)
    // A key pair stored before encryption at rest is encrypted now, not at first use.
    await encryptStoredActorKeys(strapi)
    // Strapi does not order plugins: the core may not have created the default site yet. Then this
    // does nothing, and the `siteCreated` hook (see `register`) runs it once the site exists.
    await adoptDefaultSite(strapi)
    await migrateStoredArticles(strapi)
    await registerPermissionActions(strapi)
    // After the migrations: a message left by the previous run is delivered from here on.
    startFederationQueue(strapi)
    await syncProfileAtBoot(strapi)
  },

  async destroy({ strapi }: { strapi: Core.Strapi }): Promise<void> {
    stopSiteCreated?.()
    stopSiteCreated = undefined
    unsubscribe()
    unsubscribePublisher()
    unsubscribePublisherHooks()
    unsubscribeReplies()
    await stopFederation(strapi)
    resetFedifyLogging(strapi.log)
  },

  contentTypes: {
    'federated-article': {
      schema: withSiteScope(federatedArticleSchema),
    },
    follower: {
      schema: withSiteScope(followerSchema),
    },
    interaction: {
      schema: withSiteScope(interactionSchema),
    },
  },

  config: {
    default: {},
    validator(): void {},
  },

  controllers: {
    federation,
    'plugin-page': pluginPage,
    stats,
  },

  routes,

  services: {
    'federated-articles': federatedArticles,
    interactions,
    lifecycle,
    keys,
    followers,
    'actor-profile': actorProfile,
    stats: statsService,
    'default-site': defaultSiteService,
  },
}

export default plugin
