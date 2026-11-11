/** What the plugin registers with the core's extension points (`registerAdminPage`, `registerStatusChecks`, `registerExportSection`). */

import type { LocalisedText } from '@micelio/strapi-plugin-core/strapi-server'

/** The `id` of the page, the status checks and the export section: the plugin's own. */
export const EXTENSION_ID = 'fediverse'

/** The name of the plugin in the Micelio sub-navigation and on the Status card. */
export const EXTENSION_LABEL: LocalisedText = { en: 'Fediverse', es: 'Fediverso' }

/** The page's path under `/plugins/micelio/`. */
export const ADMIN_PAGE_PATH = 'fediverse'

/** The format of the section of the archive, `major.minor` (`docs/security/data.md`). */
export const EXPORT_VERSION = '1.0'

/** The file of the section: the followers, blocked ones included, under `plugins/fediverse/`. */
export const EXPORT_FOLLOWERS_PATH = 'followers.json'

/** Most followers one import reads, so an archive cannot make the plugin hold an unbounded list. */
export const EXPORT_MAX_FOLLOWERS = 100_000
