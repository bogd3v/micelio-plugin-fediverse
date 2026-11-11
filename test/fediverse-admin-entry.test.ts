import { describe, expect, it, vi } from 'vitest'
import plugin from '../admin/src/index'
import en from '../admin/src/translations/en.json'
import es from '../admin/src/translations/es.json'

// The components load the Design System, which needs a browser: the entry only hands them over.
vi.mock('../admin/src/components/FederationPanel', () => ({ FederationPanel: () => null }))
vi.mock('../admin/src/pages/FediversePage', () => ({ default: () => null }))

type Page = () => Promise<{ default: unknown }>

/** The two plugins the entry talks to, as the admin hands them to `bootstrap`. */
function appWith(
  micelio: { apis?: unknown } | undefined,
  contentManager: { apis?: unknown } | undefined
) {
  return {
    getPlugin: vi.fn((id: string) =>
      id === 'micelio' ? micelio : id === 'content-manager' ? contentManager : undefined
    ),
  }
}

describe('The admin entry of the plugin (./strapi-admin)', () => {
  it('registers the Fediverse page with the Micelio plugin and the panel in the article side column', async () => {
    const registerPage = vi.fn<(id: string, loader: Page) => void>()
    const addEditViewSidePanel = vi.fn()

    plugin.bootstrap(appWith({ apis: { registerPage } }, { apis: { addEditViewSidePanel } }))

    expect(registerPage).toHaveBeenCalledTimes(1)
    const [id, loader] = registerPage.mock.calls[0]
    expect(id).toBe('fediverse')
    expect(typeof (await loader()).default).toBe('function')
    expect(addEditViewSidePanel).toHaveBeenCalledTimes(1)
    expect(addEditViewSidePanel.mock.calls[0][0]).toHaveLength(1)
  })

  it('adds no menu link of its own: the item comes from the Micelio sub-navigation', () => {
    const addMenuLink = vi.fn()
    const app = { addMenuLink, registerPlugin: vi.fn() }

    plugin.register(app as never)

    expect(app.registerPlugin).toHaveBeenCalledWith(expect.objectContaining({ id: 'fediverse' }))
    expect(addMenuLink).not.toHaveBeenCalled()
  })

  it('does not break the admin when the core or Content Manager is missing', () => {
    expect(() => plugin.bootstrap(appWith(undefined, undefined))).not.toThrow()
  })

  it('hands Strapi the strings of the plugin in en and es, and none for a locale it has not', async () => {
    const trads = await plugin.registerTrads({ locales: ['en', 'es', 'fr'] })

    expect(trads).toEqual([
      { locale: 'en', data: en },
      { locale: 'es', data: es },
      { locale: 'fr', data: {} },
    ])
  })
})
