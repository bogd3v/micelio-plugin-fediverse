const { withEditorial, withSiteScope } = require('@micelio/strapi-plugin-core/strapi-server')
const base = require('./base.json')

// The article as the suites boot it: the schema of base.json, or, for a suite that asks for it
// (`setupStrapi({ editorialArticle: true })` in test/strapi.ts), the schema of a host that moved
// the article to the editorial workflow with `withEditorial` (ADR-0017, section 5).
// Strapi reads the schema of a content type from `schema.json` or `schema.js`, so the choice
// lives here.
module.exports =
  process.env.FEDIVERSE_TEST_EDITORIAL_ARTICLE === 'true'
    ? withSiteScope(withEditorial(base))
    : base
