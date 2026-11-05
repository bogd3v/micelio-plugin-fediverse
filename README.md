# Micelio Plugin Fediverse

Micelio's fediverse federation (ActivityPub) as a Strapi 5 plugin.

## Getting started

```bash
npm ci
npm run check
```

Conventions, commands and structure are in [AGENTS.md](AGENTS.md); the rules every Micelio repository shares are in the [engineering standard](docs/engineering-standard.md). To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md).

## Releases

The Release workflow (`.github/workflows/release.yml`) is started by the maintainer from the Actions tab. It defaults to a dry run that prints the version and the notes. Publishing needs a `release` environment with required reviewers (Settings → Environments), and a pull request title with a conventional prefix decides the version (section 7 of the standard).

## License

[AGPL-3.0-only](LICENSE). Third-party material is listed in [THIRD-PARTY.md](THIRD-PARTY.md).
