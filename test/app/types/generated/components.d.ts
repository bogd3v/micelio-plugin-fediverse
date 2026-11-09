import type { Schema, Struct } from '@strapi/strapi'

export interface MicelioEditorialEditorial extends Struct.ComponentSchema {
  collectionName: 'components_micelio_editorial_editorials'
  info: {
    description: 'Where the entry is in the editorial workflow (ADR-0017, section 5). It changes only through a transition'
    displayName: 'Editorial'
    icon: 'check'
  }
  attributes: {
    publishAt: Schema.Attribute.DateTime
    publishedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'>
    reviewedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'>
    state: Schema.Attribute.Enumeration<['draft', 'in_review', 'scheduled', 'published']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'draft'>
  }
}

export interface MicelioSiteAccentOverride extends Struct.ComponentSchema {
  collectionName: 'components_micelio_site_accent_overrides'
  info: {
    description: "Accent color for one of the theme's modes. The frontend adjusts it if it fails contrast"
    displayName: 'Accent override'
    icon: 'paint'
  }
  attributes: {
    color: Schema.Attribute.String & Schema.Attribute.Required
    mode: Schema.Attribute.String & Schema.Attribute.Required
  }
}

export interface MicelioSiteAuthor extends Struct.ComponentSchema {
  collectionName: 'components_micelio_site_authors'
  info: {
    description: 'Who writes the site'
    displayName: 'Author'
    icon: 'user'
  }
  attributes: {
    name: Schema.Attribute.String & Schema.Attribute.Required
    url: Schema.Attribute.String
  }
}

export interface MicelioSiteFediverse extends Struct.ComponentSchema {
  collectionName: 'components_micelio_site_fediverses'
  info: {
    description: "How the blog's fediverse account looks (name, bio, header). Empty fields use the deprecated FEDIVERSE_ACTOR_* variables, then the site identity"
    displayName: 'Fediverse profile'
    icon: 'globe'
  }
  attributes: {
    discoverable: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>
    displayName: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100
      }>
    header: Schema.Attribute.Media<'images'>
    objectType: Schema.Attribute.Enumeration<['article', 'note']> &
      Schema.Attribute.DefaultTo<'note'>
    sourceUrl: Schema.Attribute.String
    summary: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 500
      }>
    username: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 30
      }>
  }
}

export interface MicelioSiteModules extends Struct.ComponentSchema {
  collectionName: 'components_micelio_site_modules'
  info: {
    description: 'Features the frontend turns on. All of them are on unless turned off here'
    displayName: 'Modules'
    icon: 'puzzle'
  }
  attributes: {
    accounts: Schema.Attribute.Boolean &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<true>
    comments: Schema.Attribute.Boolean &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<true>
    drafts: Schema.Attribute.Boolean & Schema.Attribute.Required & Schema.Attribute.DefaultTo<true>
    fediverse: Schema.Attribute.Boolean &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<true>
    newsletter: Schema.Attribute.Boolean &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<true>
    search: Schema.Attribute.Boolean & Schema.Attribute.Required & Schema.Attribute.DefaultTo<true>
    support: Schema.Attribute.Boolean & Schema.Attribute.Required & Schema.Attribute.DefaultTo<true>
  }
}

export interface MicelioSiteSocialLink extends Struct.ComponentSchema {
  collectionName: 'components_micelio_site_social_links'
  info: {
    description: 'A profile of the site on another network'
    displayName: 'Social link'
    icon: 'link'
  }
  attributes: {
    network: Schema.Attribute.Enumeration<
      ['github', 'gitlab', 'codeberg', 'linkedin', 'mastodon', 'bluesky', 'x', 'website']
    > &
      Schema.Attribute.Required
    url: Schema.Attribute.String & Schema.Attribute.Required
  }
}

export interface MicelioSiteTheme extends Struct.ComponentSchema {
  collectionName: 'components_micelio_site_themes'
  info: {
    description: 'Installed theme and its bounded overrides (micelio ADR 0005). Empty fields use the theme as it is'
    displayName: 'Theme'
    icon: 'brush'
  }
  attributes: {
    accentOverrides: Schema.Attribute.Component<'micelio-site.accent-override', true>
    defaultMode: Schema.Attribute.String
    displayFont: Schema.Attribute.Enumeration<
      ['archivo', 'fraunces', 'bricolage-grotesque', 'newsreader', 'space-grotesk']
    >
    themeDigest: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 128
      }>
    themeId: Schema.Attribute.String
    themeVersion: Schema.Attribute.String
  }
}

export interface SharedImageCredit extends Struct.ComponentSchema {
  collectionName: 'components_shared_image_credits'
  info: {
    description: 'Who made an image, where it comes from and under which license'
    displayName: 'Image credit'
    icon: 'picture'
  }
  attributes: {
    author: Schema.Attribute.String
    authorUrl: Schema.Attribute.String
    kind: Schema.Attribute.Enumeration<['photo', 'illustration', 'diagram', 'screenshot']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'photo'>
    license: Schema.Attribute.Enumeration<
      [
        'own-work',
        'cc0',
        'public-domain',
        'cc-by-4.0',
        'cc-by-sa-4.0',
        'cc-by-nc-4.0',
        'unsplash',
        'permission',
        'other',
      ]
    > &
      Schema.Attribute.Required
    licenseUrl: Schema.Attribute.String
    modifications: Schema.Attribute.String
    source: Schema.Attribute.String
    sourceUrl: Schema.Attribute.String
  }
}

export interface SharedMetaSocial extends Struct.ComponentSchema {
  collectionName: 'components_shared_meta_socials'
  info: {
    description: ''
    displayName: 'metaSocial'
    icon: 'project-diagram'
  }
  attributes: {
    description: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200
      }>
    image: Schema.Attribute.Media<'images' | 'files' | 'videos'>
    socialNetwork: Schema.Attribute.Enumeration<['Facebook', 'Twitter']> & Schema.Attribute.Required
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 70
      }>
  }
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos'
  info: {
    description: ''
    displayName: 'seo'
    icon: 'search'
  }
  attributes: {
    canonicalURL: Schema.Attribute.String
    keywords: Schema.Attribute.Text
    metaDescription: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 160
        minLength: 50
      }>
    metaImage: Schema.Attribute.Media<'images' | 'files' | 'videos'> & Schema.Attribute.Required
    metaRobots: Schema.Attribute.String
    metaSocial: Schema.Attribute.Component<'shared.meta-social', true>
    metaTitle: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60
      }>
    metaViewport: Schema.Attribute.String
    structuredData: Schema.Attribute.JSON
  }
}

declare module '@strapi/strapi' {
  export namespace Public {
    export interface ComponentSchemas {
      'micelio-editorial.editorial': MicelioEditorialEditorial
      'micelio-site.accent-override': MicelioSiteAccentOverride
      'micelio-site.author': MicelioSiteAuthor
      'micelio-site.fediverse': MicelioSiteFediverse
      'micelio-site.modules': MicelioSiteModules
      'micelio-site.social-link': MicelioSiteSocialLink
      'micelio-site.theme': MicelioSiteTheme
      'shared.image-credit': SharedImageCredit
      'shared.meta-social': SharedMetaSocial
      'shared.seo': SharedSeo
    }
  }
}
