import type { ContentManagerPlugin } from '@strapi/content-manager/strapi-admin'
import type { StrapiApp } from '@strapi/strapi/admin'

import { FederationPanel } from './components/FederationPanel'
import en from './translations/en.json'
import es from './translations/es.json'

const PLUGIN_ID = 'fediverse'

/** The admin strings of the plugin by locale, handed to Strapi by `registerTrads`. */
const translations: Record<string, Record<string, string>> = { en, es }

/** The part of the admin app `bootstrap` uses: the plugins registered so far. */
interface PluginLookup {
  getPlugin(id: string): { apis?: unknown } | undefined
}

/** What the Micelio admin plugin offers to a sibling's admin (`apis` of `@micelio/strapi-plugin-core`). */
interface MicelioApis {
  registerPage: (id: string, loader: () => Promise<{ default: React.ComponentType }>) => void
}

/**
 * The plugin's admin entry, the package's `./strapi-admin` export.
 *
 * @remarks
 * Strapi bundles it for every host that has the plugin enabled in its `config/plugins.ts` when the
 * admin is built, so the host enables the plugin always and the server reads `FEDIVERSE_ENABLED`
 * itself (`server/src/index.ts`). Off, nothing here shows: the page's menu item is registered on
 * the server and needs `plugin::fediverse.read`, which does not exist then, and the article panel
 * tells the editor that federation is off from the routes it cannot reach.
 */
const plugin = {
  register(app: StrapiApp): void {
    app.registerPlugin({ id: PLUGIN_ID, name: PLUGIN_ID, isReady: true })
  },

  /**
   * The Micelio and Content Manager plugins are registered by now, whatever the order the admin
   * registers plugins in: the page goes to the Micelio sub-navigation (the item is listed by the
   * server's `registerAdminPage`) and the federation panel to the side column of the article.
   */
  bootstrap(app: PluginLookup): void {
    const micelio = app.getPlugin('micelio')?.apis as Partial<MicelioApis> | undefined
    micelio?.registerPage?.(PLUGIN_ID, () => import('./pages/FediversePage'))

    const contentManager = app.getPlugin('content-manager')?.apis as
      Partial<ContentManagerPlugin['config']['apis']> | undefined
    contentManager?.addEditViewSidePanel?.([FederationPanel])
  },

  async registerTrads({
    locales,
  }: {
    locales: string[]
  }): Promise<{ locale: string; data: Record<string, string> }[]> {
    return locales.map((locale) => ({ locale, data: translations[locale] ?? {} }))
  },
}

export default plugin
