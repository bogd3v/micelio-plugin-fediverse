import type { Core } from '@strapi/strapi'

import { ACTOR_COMPONENT_UID, SECTION_ID, SECTION_LABEL } from '../constants/site-actor'
import { PERMISSION_READ } from '../constants/permissions'
import { extensionsOf } from '../utils/core-extensions'

/**
 * The component of the section: the actor's `identifier` and nothing else. It has no default, so
 * a site that never set one is told from a site that did: the core gives every site a `{}` instance.
 */
const ACTOR_COMPONENT_SCHEMA = {
  collectionName: 'components_fediverse_actors',
  info: {
    displayName: 'Fediverse actor',
    icon: 'globe',
    description:
      'The path of the site’s actor (/fediverse/user/<identifier>). It cannot change once set: remote servers key the followers by it',
  },
  options: {},
  attributes: {
    identifier: { type: 'string', maxLength: 64 },
  },
} as const

/**
 * Registers the `fediverse-actor` section on every site (`registerSiteSection` of the core), with
 * its component added to Strapi's registry first. Called from `register()`: Strapi builds the
 * database models after it.
 */
export function registerActorSection(strapi: Core.Strapi): void {
  const [category, name] = ACTOR_COMPONENT_UID.split('.')
  strapi.get('components').add({
    [ACTOR_COMPONENT_UID]: {
      ...structuredClone(ACTOR_COMPONENT_SCHEMA),
      __schema__: structuredClone(ACTOR_COMPONENT_SCHEMA),
      uid: ACTOR_COMPONENT_UID,
      category,
      modelType: 'component',
      modelName: name,
      globalId: 'ComponentFediverseActor',
    },
  })
  extensionsOf(strapi).registerSiteSection({
    id: SECTION_ID,
    component: ACTOR_COMPONENT_UID,
    label: SECTION_LABEL,
    panel: ACTOR_COMPONENT_UID,
    permission: PERMISSION_READ,
  })
}
