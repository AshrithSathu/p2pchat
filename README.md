# p2pchat

[![npm version](https://img.shields.io/npm/v/@ashrithsathu/p2pchat.svg)](https://www.npmjs.com/package/@ashrithsathu/p2pchat)
[![CI](https://github.com/AshrithSathu/p2pchat/actions/workflows/ci.yml/badge.svg)](https://github.com/AshrithSathu/p2pchat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ashrithsathu/p2pchat.svg)](LICENSE)

Fast, local-first, end-to-end encrypted terminal chat written in strict
TypeScript. Peers can connect across ordinary NAT and firewall boundaries using
short-lived invite codes and an opaque Cloudflare WebSocket relay.

Website: [p2pchat.sathuashrith.com](https://p2pchat.sathuashrith.com)

> [!IMPORTANT]
> p2pchat is production-hardened but has not received an independent security
> audit. Read the [security model](#security-model) and [security policy](SECURITY.md)
> before using it for sensitive conversations.

## Install

Requirements: Node.js 22.19 or newer and Corepack.

One-command install for macOS and Linux:

```sh
curl -fsSL https://p2pchat-relay.sathuashrith.com/install.sh | sh
```

The installer is version-pinned, never invokes `sudo`, and verifies the
installed command. To inspect it before running:

```sh
curl -fsSLo p2pchat-install.sh \
  https://p2pchat-relay.sathuashrith.com/install.sh
less p2pchat-install.sh
sh p2pchat-install.sh
```

You can also install directly from npm with pnpm:

```sh
corepack enable
corepack pnpm add --global \
  --allow-build=better-sqlite3 \
  --allow-build=@signalapp/libsignal-client \
  @ashrithsathu/p2pchat
```

The standard npm client is supported too:

```sh
npm install --global @ashrithsathu/p2pchat
```

Start or create a local profile:

```sh
p2pchat --profile alice
```

Each profile has its own password, database with encrypted sensitive records,
Ed25519 identity, Signal identity, ratchet state, peers, and message history.
The password is requested through a hidden terminal prompt and is never accepted
through an environment variable.

## Start a chat

On the first device:

1. Run `p2pchat --profile alice`.
2. Type `/` and select `/new`.
3. Send the displayed one-time code to the other person over a private channel.

On the second device:

1. Run `p2pchat --profile bob`.
2. Select `/join`, paste the invite code, and press Enter.
3. Compare the safety number shown on both screens using a trusted channel.

Messages can be typed normally after authentication. `✓✓` means the peer
acknowledged receipt.

## Commands

| Command        | Action                                         |
| -------------- | ---------------------------------------------- |
| `/new`         | Create a short-lived Internet invitation       |
| `/new-local`   | Create a direct invitation for reachable peers |
| `/join <code>` | Join an Internet or direct invitation          |
| `/clear`       | Clear the activity panel                       |
| `/help`        | Show command help                              |
| `/source`      | Show source corresponding to this version      |
| `/license`     | Show licensing information                     |
| `/quit`        | Close connections and exit safely              |

Typing `/` opens Pi-style command autocomplete. Continue typing to fuzzy-filter,
use Up/Down to select, Tab to insert without running, Enter to execute, and
Escape to close the menu. `/exit` is an alias for `/quit`.

## Local profiles

Profile names are case-insensitive and contain 1-32 letters, numbers, `_`, or
`-`. Running without `--profile` opens `default`.

```sh
p2pchat --profile alice
p2pchat --profile bob
```

Profiles are stored separately under the platform data directory:

| Platform | Default location                                                                     |
| -------- | ------------------------------------------------------------------------------------ |
| macOS    | `~/Library/Application Support/p2pchat/profiles/<name>`                              |
| Linux    | `~/.local/share/p2pchat/profiles/<name>` or `$XDG_DATA_HOME/p2pchat/profiles/<name>` |
| Windows  | `%LOCALAPPDATA%\p2pchat\profiles\<name>`                                             |

Set `P2PCHAT_DATA_DIR` to override the shared data root. Existing databases from
versions before profiles remain available through the `default` profile.

## How connections work

- `/new` uses the production relay at
  `https://p2pchat-relay.sathuashrith.com`.
- The invite code contains a high-entropy secret used to authenticate the
  rendezvous and establish encrypted transport keys.
- Signal PQXDH establishes the application session, and every message is
  protected by the Double Ratchet.
- The relay forwards opaque ciphertext and does not store chat messages.
- `/new-local` keeps the original direct TCP/libp2p mode for peers that can
  reach one another without the relay.

Use `P2PCHAT_RELAY_URL=https://relay.example.com` to select a compatible
self-hosted relay.

## Security model

- The exact-pinned `@signalapp/libsignal-client@0.99.3` package provides PQXDH
  session establishment and Double Ratchet message encryption.
- Signal identity keys are pinned to authenticated Ed25519 peer identities. A
  changed identity is rejected, and the safety number covers both identity
  systems.
- Direct connections use Noise in addition to the inner Signal layer.
- Relay connections use an authenticated Ed25519/X25519 handshake and
  directional AES-256-GCM transport keys around the inner Signal layer.
- Message bodies, private identities, prekeys, trusted peer state, and ratchet
  sessions are encrypted in SQLite using AES-256-GCM. The local key is derived
  from the profile password with scrypt.
- Profile directories use owner-only permissions on supported operating
  systems, and SQLite secure deletion is enabled.
- Received messages are stripped of terminal control and bidirectional override
  characters before display.

The database is not fully opaque: timestamps, delivery state, sequence numbers,
public keys, and peer identifiers remain visible. Cloudflare can observe IP
addresses, timing, room locators, and ciphertext sizes. A compromised unlocked
device, administrator access, malware, backups, filesystem snapshots, or an
exposed/weak profile password can defeat local protection.

This project is not affiliated with Signal. Signal documents external use of
libsignal as unsupported, so the exact dependency version is intentionally
pinned.

## Development

```sh
git clone https://github.com/AshrithSathu/p2pchat.git
cd p2pchat
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev --profile alice
```

Run the complete client, relay, and landing-page checks before submitting
changes:

```sh
corepack pnpm check
corepack pnpm build
```

The checks include strict TypeScript, ESLint, formatting, protocol and storage
tests, a Workers-runtime Durable Object integration test, and a Wrangler deploy
dry run for both Cloudflare projects. See [CONTRIBUTING.md](CONTRIBUTING.md) for
the development workflow.

## Landing page development

The public website is isolated in [`landing/`](landing/README.md). It is a
static, tracker-free Cloudflare Workers Assets deployment and does not share
runtime code with the client or relay.

```sh
corepack pnpm landing:dev
corepack pnpm landing:check
corepack pnpm landing:deploy
```

## Relay development

```sh
corepack pnpm relay:dev
corepack pnpm relay:test
corepack pnpm relay:deploy
```

To exercise the full client protocol against the deployed relay:

```sh
P2PCHAT_LIVE_RELAY_TEST=1 corepack pnpm exec vitest run \
  src/relay/live.integration.test.ts
```

The relay is separately MIT-licensed and does not link libsignal.

## License

The terminal client is licensed under
[GNU AGPL-3.0-only](LICENSE). The Cloudflare relay is licensed under
[MIT](relay/LICENSE).
