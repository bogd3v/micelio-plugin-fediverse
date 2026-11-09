# Third-party material

Micelio Plugin Fediverse's license ([LICENSE](LICENSE), AGPL-3.0-only) covers only the work of Micelio's contributors. **Third-party material is not part of that licensing**: it keeps the license its authors gave it, and whoever reuses it follows that license.

When you add some (code, fonts, images, logos), list it here with its source and license, keep its license file next to it, and annotate its path in [REUSE.toml](REUSE.toml), the machine-readable version of this list (`reuse lint` checks it in CI; the license texts are in `LICENSES/`).

## Dependencies

npm packages (`package.json`, `package-lock.json`) are distributed under their own licenses, which each package carries. `npm run lint:licenses` fails when a production dependency has a license that cannot be combined with AGPL-3.0; the allowlist is the one shipped in `@micelio/eslint-config`, and the exceptions, each with its reason, are in `scripts/licenses-allow.json`.
