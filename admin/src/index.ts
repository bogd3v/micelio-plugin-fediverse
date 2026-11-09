import type { ContentManagerPlugin } from '@strapi/content-manager/strapi-admin'
import { Earth } from '@strapi/icons'
import type { StrapiApp } from '@strapi/strapi/admin'

import { FederationPanel } from './components/FederationPanel'
import { READ_PERMISSION } from './permissions'
import en from './translations/en.json'
import es from './translations/es.json'

/** The admin strings of the plugin by locale; `src/admin/app.tsx` hands them to Strapi. */
export const fediverseTranslations: Record<'en' | 'es', Record<string, string>> = { en, es }

/**
 * Adds the federation panel to the side column of the article edit view.
 *
 * @remarks
 * Called from `src/admin/app.tsx` instead of exported as the plugin's `./strapi-admin`: Strapi
 * bundles a local plugin's admin code only when the plugin is enabled while the admin is built,
 * and the image is built with `FEDIVERSE_ENABLED` unset. The panel tells a site where
 * federation is off by the routes it cannot reach.
 */
export function registerFederationPanel(app: Pick<StrapiApp, 'getPlugin'>): void {
  const { apis } = app.getPlugin('content-manager')
  ;(apis as ContentManagerPlugin['config']['apis']).addEditViewSidePanel([FederationPanel])
}

/**
 * Adds the Fediverse page to the admin menu, for the roles that have `plugin::fediverse.read`.
 *
 * @remarks
 * That permission exists only while the plugin is enabled on the server, so on a site where
 * federation is off no role has it and the entry does not show, even though the code is always
 * in the bundle (see `registerFederationPanel`).
 */
export function registerFediversePage(app: Pick<StrapiApp, 'addMenuLink'>): void {
  app.addMenuLink({
    to: '/plugins/fediverse',
    icon: Earth,
    intlLabel: { id: 'fediverse.page.menu', defaultMessage: 'Fediverse' },
    permissions: [READ_PERMISSION],
    Component: () => import('./pages/FediversePage'),
  })
}
