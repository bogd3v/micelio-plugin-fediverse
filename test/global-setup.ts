import { execFileSync } from 'node:child_process'

/**
 * Builds the plugin once per run: the suites boot Strapi on `dist/strapi-server.js`, as a host
 * that installed the package would.
 */
export default function setup(): void {
  execFileSync('npm', ['run', 'build', '--silent'], { stdio: 'inherit' })
}
