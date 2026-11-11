import type { Check, ExtensionSite, LocalisedText } from '@micelio/strapi-plugin-core/strapi-server'
import type { Core } from '@strapi/strapi'

import en from '../../../admin/src/translations/en.json'
import es from '../../../admin/src/translations/es.json'
import { EXTENSION_ID, EXTENSION_LABEL } from '../constants/extensions'
import { PERMISSION_READ } from '../constants/permissions'
import type { Diagnostic } from '../types/plugin-page'
import { extensionsOf } from '../utils/core-extensions'
import { runSiteChecks } from './diagnostics'

const TITLES = {
  'public-url': 'fediverse.page.check.public-url',
  'actor-key': 'fediverse.page.check.actor-key',
  webfinger: 'fediverse.page.check.webfinger',
} as const

/** A text of the page's strings in both languages; the id as the text when a string is missing. */
function text(id: string): LocalisedText {
  const messages = { en, es } as Record<'en' | 'es', Record<string, string>>
  return { en: messages.en[id] ?? id, es: messages.es[id] ?? id }
}

/**
 * A diagnostic of the page as a check of the core: its id stays the same whatever the status, and
 * the failure code is the `detail` (the same in both languages: it is a code, not a sentence).
 */
function toCheck(diagnostic: Diagnostic): Check {
  const title = text(TITLES[diagnostic.id as keyof typeof TITLES])
  if (diagnostic.ok === true) return { id: diagnostic.id, title, status: 'ok' }
  const code = diagnostic.code ?? 'unknown'
  return {
    id: diagnostic.id,
    title,
    status: 'fail',
    detail: { en: code, es: code },
    fix: text(`fediverse.page.fix.${code}`),
  }
}

/**
 * The checks of one site for the Status page: the public address, the actor key and WebFinger.
 * The figures (followers, refusals, backend) stay on the plugin page.
 */
export async function statusChecksOf(strapi: Core.Strapi, site: ExtensionSite): Promise<Check[]> {
  return (await runSiteChecks(strapi, site.documentId)).map(toCheck)
}

/** Registers the status checks with the core. Called from `register()`. */
export function registerStatusChecks(strapi: Core.Strapi): void {
  extensionsOf(strapi).registerStatusChecks({
    id: EXTENSION_ID,
    label: EXTENSION_LABEL,
    permission: PERMISSION_READ,
    run: (site) => statusChecksOf(strapi, site),
  })
}
