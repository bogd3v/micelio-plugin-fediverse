/** The site section the plugin registers with the core: the actor path of each site. */

import type { LocalisedText } from '@micelio/strapi-plugin-core/strapi-server'

/** The `id` of the section (`registerSiteSection`). */
export const SECTION_ID = 'fediverse-actor'

/** The UID of the section's component, in `strapi.components`. */
export const ACTOR_COMPONENT_UID = 'fediverse.actor'

/**
 * The attribute of `plugin::micelio.site` that holds the section: the core names it from the
 * section's `id` (`section_` + the id with hyphens turned into underscores).
 */
export const SECTION_ATTRIBUTE = 'section_fediverse_actor'

/** The label of the section in the Micelio admin. */
export const SECTION_LABEL: LocalisedText = {
  en: 'Fediverse actor',
  es: 'Actor del fediverso',
}

/** The plugin store entry that records that the 0.7 boot step completed. */
export const CUT_OVER_STORE = { type: 'plugin', name: 'fediverse' } as const
/** The key of the marker in that entry. */
export const CUT_OVER_KEY = 'cut-over-0.7'
