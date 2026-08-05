const PACKAGE_NAME = '@ashrithsathu/p2pchat';
const PACKAGE_VERSION = '0.5.0';

export const INSTALL_SCRIPT = `#!/bin/sh
set -eu

package_name='${PACKAGE_NAME}'
package_version='${PACKAGE_VERSION}'
package_spec="$package_name@$package_version"

fail() {
  printf '%s\n' "p2pchat installer: $*" >&2
  exit 1
}

platform=$(uname -s 2>/dev/null || printf 'unknown')
case "$platform" in
  Darwin|Linux) ;;
  *) fail "unsupported platform $platform; use npm install --global $package_spec instead" ;;
esac

command -v node >/dev/null 2>&1 || fail 'Node.js 22.19 or newer is required: https://nodejs.org/'
command -v npm >/dev/null 2>&1 || fail 'npm is required and normally ships with Node.js'

if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)"; then
  fail "Node.js 22.19 or newer is required; found $(node --version)"
fi

printf 'Installing %s...\n' "$package_spec"
if ! npm install --global --no-audit --no-fund "$package_spec"; then
  fail 'npm could not install globally; use a user-owned Node.js installation instead of sudo'
fi

hash -r 2>/dev/null || true
command -v p2pchat >/dev/null 2>&1 || fail 'installed successfully, but p2pchat is not on PATH; restart your terminal and try again'

installed_version=$(p2pchat --version 2>/dev/null || true)
[ "$installed_version" = "$package_version" ] || fail "expected version $package_version but found $installed_version"

printf '\np2pchat %s installed successfully.\n' "$installed_version"
printf 'Start with: p2pchat --profile alice\n'
`;

const LANDING_PAGE = `p2pchat — end-to-end encrypted terminal chat

Quick install for macOS and Linux (Node.js 22.19+):

  curl -fsSL https://p2pchat-relay.sathuashrith.com/install.sh | sh

Inspect before running:

  curl -fsSLo p2pchat-install.sh https://p2pchat-relay.sathuashrith.com/install.sh
  less p2pchat-install.sh
  sh p2pchat-install.sh

npm:   https://www.npmjs.com/package/@ashrithsathu/p2pchat
source: https://github.com/AshrithSathu/p2pchat
`;

const PUBLIC_TEXT_HEADERS = {
  'Cache-Control': 'public, max-age=300, must-revalidate',
  'Content-Security-Policy': "default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
} as const;

export function installerResponse(method: string): Response {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed\n', {
      status: 405,
      headers: {
        ...PUBLIC_TEXT_HEADERS,
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  return new Response(method === 'HEAD' ? null : INSTALL_SCRIPT, {
    headers: {
      ...PUBLIC_TEXT_HEADERS,
      'Content-Disposition': 'inline; filename="p2pchat-install.sh"',
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'X-p2pchat-Version': PACKAGE_VERSION,
    },
  });
}

export function landingPageResponse(method: string): Response {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed\n', {
      status: 405,
      headers: {
        ...PUBLIC_TEXT_HEADERS,
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  return new Response(method === 'HEAD' ? null : LANDING_PAGE, {
    headers: {
      ...PUBLIC_TEXT_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
