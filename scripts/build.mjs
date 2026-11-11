// Bundles the plugin into dist/ with esbuild:
//   dist/strapi-server.js  the server (Node, CommonJS), the `./strapi-server` export
//   dist/strapi-admin.mjs  the admin entry (browser, ES module), the `import` of `./strapi-admin`
//   dist/strapi-admin.js   the same as CommonJS, for the `require` and `default` of `./strapi-admin`
// Dependencies stay external: the host's Strapi provides React, the Design System and the rest.
//
//   node scripts/build.mjs [--watch]
import { context } from 'esbuild'

const watch = process.argv.includes('--watch')

const common = { bundle: true, packages: 'external', logLevel: 'info' }
const admin = {
  ...common,
  entryPoints: ['admin/src/index.ts'],
  platform: 'browser',
  jsx: 'automatic',
}

const builds = [
  {
    ...common,
    entryPoints: ['server/src/index.ts'],
    platform: 'node',
    format: 'cjs',
    outfile: 'dist/strapi-server.js',
  },
  { ...admin, format: 'esm', outfile: 'dist/strapi-admin.mjs' },
  { ...admin, format: 'cjs', outfile: 'dist/strapi-admin.js' },
]

for (const options of builds) {
  const ctx = await context(options)
  if (watch) {
    await ctx.watch()
  } else {
    await ctx.rebuild()
    await ctx.dispose()
  }
}
