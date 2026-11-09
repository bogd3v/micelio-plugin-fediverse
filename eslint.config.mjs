import micelio from '@micelio/eslint-config'

export default [
  ...micelio,
  {
    // CommonJS, as Strapi loads them: the configuration, the content types and the middlewares of
    // the clean Strapi the suites boot.
    files: ['test/app/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // What `strapi ts:generate-types` writes (test/app/types), what the build writes, and what
    // Strapi leaves in the test app.
    ignores: ['dist/**', 'test/app/types/**', 'test/app/.strapi/**', 'test/app/.tmp/**'],
  },
]
