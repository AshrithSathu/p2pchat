import type { ReleaseManifest, ReleasePlatform } from './distribution.js';

const PUBLIC_TEXT_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
} as const;

export function installerResponse(
  method: string,
  requestUrl: string,
  manifest: ReleaseManifest,
): Response {
  if (method !== 'GET' && method !== 'HEAD') {
    return methodNotAllowed();
  }

  return new Response(
    method === 'HEAD' ? null : createInstallScript(requestUrl, manifest),
    {
      headers: {
        ...PUBLIC_TEXT_HEADERS,
        'Content-Disposition': 'inline; filename="p2pchat-install.sh"',
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'X-p2pchat-Version': manifest.version,
      },
    },
  );
}

export function landingPageResponse(
  method: string,
  manifest: ReleaseManifest,
): Response {
  if (method !== 'GET' && method !== 'HEAD') {
    return methodNotAllowed();
  }

  const page = `p2pchat — end-to-end encrypted terminal chat

Latest version: ${manifest.version}

Quick install for macOS and Linux (Node.js 22.19+):

  curl -fsSL https://p2pchat-relay.sathuashrith.com/install.sh | sh

Inspect before running:

  curl -fsSLo p2pchat-install.sh https://p2pchat-relay.sathuashrith.com/install.sh
  less p2pchat-install.sh
  sh p2pchat-install.sh

Corresponding source:
  https://p2pchat-relay.sathuashrith.com/downloads/${manifest.source.filename}
`;

  return new Response(method === 'HEAD' ? null : page, {
    headers: {
      ...PUBLIC_TEXT_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

function createInstallScript(
  requestUrl: string,
  manifest: ReleaseManifest,
): string {
  const origin = new URL(requestUrl).origin;
  const artifactCases = (
    Object.entries(manifest.artifacts) as [
      ReleasePlatform,
      ReleaseManifest['artifacts'][ReleasePlatform],
    ][]
  )
    .map(
      ([platform, artifact]) => `  ${platform})
    archive_url='${origin}/downloads/${artifact.filename}'
    archive_sha256='${artifact.sha256}'
    ;;`,
    )
    .join('\n');

  return `#!/bin/sh
set -eu

version='${manifest.version}'
source_url='${origin}/downloads/${manifest.source.filename}'

fail() {
  printf '%s\n' "p2pchat installer: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'Node.js 22.19 or newer is required: https://nodejs.org/'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'

if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)"; then
  fail "Node.js 22.19 or newer is required; found $(node --version)"
fi

case "$(uname -s 2>/dev/null || printf unknown)" in
  Darwin) os='darwin' ;;
  Linux) os='linux' ;;
  *) fail 'only macOS and Linux are currently supported' ;;
esac

case "$(uname -m 2>/dev/null || printf unknown)" in
  arm64|aarch64) cpu='arm64' ;;
  x86_64|amd64) cpu='x64' ;;
  *) fail 'only x64 and arm64 processors are currently supported' ;;
esac

target="$os-$cpu"
case "$target" in
${artifactCases}
  *) fail "no p2pchat build is available for $target" ;;
esac

install_root="\${P2PCHAT_INSTALL_ROOT:-$HOME/.local/share/p2pchat}"
bin_dir="\${P2PCHAT_BIN_DIR:-$HOME/.local/bin}"
versions_dir="$install_root/versions"
target_dir="$versions_dir/$version"
tmp_dir=$(mktemp -d "\${TMPDIR:-/tmp}/p2pchat-install.XXXXXX")

cleanup() {
  case "$tmp_dir" in
    */p2pchat-install.*) rm -rf -- "$tmp_dir" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

archive="$tmp_dir/p2pchat.tar.gz"
printf 'Downloading p2pchat %s for %s...\n' "$version" "$target"
curl --fail --location --silent --show-error --retry 3 \
  --proto '=https' --tlsv1.2 --output "$archive" "$archive_url"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256=$(shasum -a 256 "$archive" | awk '{print $1}')
else
  fail 'sha256sum or shasum is required to verify the download'
fi
[ "$actual_sha256" = "$archive_sha256" ] || fail 'download checksum verification failed'

if ! tar -tzf "$archive" | awk '
  index($0, "p2pchat/") != 1 { invalid = 1 }
  {
    count = split($0, parts, "/")
    for (part_index = 1; part_index <= count; part_index += 1) {
      if (parts[part_index] == "..") invalid = 1
    }
  }
  END { exit invalid }
'; then
  fail 'download contains an unsafe archive path'
fi

tar -xzf "$archive" -C "$tmp_dir"
[ -f "$tmp_dir/p2pchat/dist/cli.js" ] || fail 'download is missing the p2pchat executable'
mkdir -p "$versions_dir" "$bin_dir"

if [ -e "$target_dir" ]; then
  existing_version=$(node "$target_dir/dist/cli.js" --version 2>/dev/null || true)
  [ "$existing_version" = "$version" ] || fail "existing $target_dir is invalid; move it aside and retry"
else
  mv "$tmp_dir/p2pchat" "$target_dir"
fi

chmod u+x "$target_dir/dist/cli.js"
link_tmp="$bin_dir/.p2pchat.$$.tmp"
ln -s "$target_dir/dist/cli.js" "$link_tmp"
mv -f "$link_tmp" "$bin_dir/p2pchat"
hash -r 2>/dev/null || true

installed_version=$("$bin_dir/p2pchat" --version 2>/dev/null || true)
[ "$installed_version" = "$version" ] || fail "expected version $version but found $installed_version"

printf '\np2pchat %s installed successfully.\n' "$installed_version"
printf 'Start with: %s --profile alice\n' "$bin_dir/p2pchat"
printf 'Corresponding source: %s\n' "$source_url"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add %s to PATH to run p2pchat from anywhere.\n' "$bin_dir" ;;
esac
`;
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed\n', {
    status: 405,
    headers: {
      ...PUBLIC_TEXT_HEADERS,
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
