# p2pchat

[![CI](https://github.com/AshrithSathu/p2pchat/actions/workflows/ci.yml/badge.svg)](https://github.com/AshrithSathu/p2pchat/actions/workflows/ci.yml)

Fast, local-first, end-to-end encrypted terminal chat written in strict
TypeScript. Peers can connect across ordinary NAT and firewall boundaries using
short-lived invite codes and an opaque Cloudflare WebSocket relay.

Website: [p2pchat.sathuashrith.com](https://p2pchat.sathuashrith.com)

> [!IMPORTANT]
> p2pchat is production-hardened but has not received an independent security
> audit. Read the [security model](#security-model) and [security policy](SECURITY.md)
> before using it for sensitive conversations.

## Install

Requirement: Node.js 22.19 or newer.

One-command install for macOS and Linux:

```sh
curl -fsSL https://p2pchat-relay.sathuashrith.com/install.sh | sh
```

The installer downloads a platform-specific archive from the p2pchat release
service, verifies its SHA-256 checksum, never invokes `sudo`, and atomically
switches `~/.local/bin/p2pchat` to the verified version. It does not install the
application from npm. To inspect it before running:

```sh
curl -fsSLo p2pchat-install.sh \
  https://p2pchat-relay.sathuashrith.com/install.sh
less p2pchat-install.sh
sh p2pchat-install.sh
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

## Reply to a message

Press `Ctrl+R` to open the recent-message picker. Use Up/Down to choose the
exact message, Enter to select it, and Escape to cancel. The composer shows a
compact quote; type a response or attach an image and press Enter to send.

The reply reference travels inside the Signal-encrypted message and is stored
as a separate encrypted value in the local database. A reply can only target a
message from the same conversation.

## Send images

Copy an image and press `Ctrl+V` in p2pchat (`Alt+V` on Windows), or drop an
image file into the terminal. A pending thumbnail appears; type an optional
caption and press Enter to send it. Press Escape to remove the pending image.

PNG, JPEG, GIF, and WebP images up to 2 MiB are supported. One image can be
attached to each message. Kitty, Ghostty, WezTerm, Warp, and iTerm2 display
images inline using terminal-native graphics. Other terminals show a compact
metadata fallback.

## Make an encrypted video call

Video calls are available after connecting through an Internet relay invite.
Type `/call`; p2pchat opens a localhost-only browser window where the operating
system asks for camera and microphone permission. The other terminal receives
an accept/decline prompt. Use `/hangup` or the red button in the call window to
end the call.

Calls are deliberately one-to-one and fail closed:

- SDP offers and answers travel inside the authenticated Signal Double Ratchet.
- WebRTC encrypts audio and video end to end with DTLS-SRTP.
- `iceTransportPolicy: "relay"` is mandatory. Both SDP candidates and the
  selected WebRTC candidate pair are checked to be TURN relays.
- Camera/microphone transmission and remote playback remain disabled until the
  selected TURN candidate pair has been independently verified.
- There is no direct WebRTC fallback. If TURN is unavailable, the call fails.
- Participants do not receive one another's IP addresses. The selected TURN
  operator still observes each participant's IP address, timing, and encrypted
  traffic volume.
- Camera and microphone data are never written to the p2pchat database. Calls
  are not recorded.

The call window must remain open while the call is active. Video calls are not
available in `/new-local` direct chats because that route cannot provide the
peer-IP-hiding guarantee.

## Commands

| Command        | Action                                         |
| -------------- | ---------------------------------------------- |
| `/new`         | Create a short-lived Internet invitation       |
| `/new-local`   | Create a direct invitation for reachable peers |
| `/join <code>` | Join an Internet or direct invitation          |
| `/call`        | Start a TURN-only encrypted video call         |
| `/hangup`      | End the current video call                     |
| `/update`      | Install the latest published p2pchat version   |
| `/clear`       | Clear the activity panel                       |
| `/help`        | Show command help                              |
| `/source`      | Show source corresponding to this version      |
| `/license`     | Show licensing information                     |
| `/quit`        | Close connections and exit safely              |

Typing `/` opens Pi-style command autocomplete. Continue typing to fuzzy-filter,
use Up/Down to select, Tab to insert without running, Enter to execute, and
Escape to close the menu. `/exit` is an alias for `/quit`.

At startup, p2pchat checks the first-party release service for a newer version
without delaying the interface. When one exists, a dismissible popup shows the
installed and latest versions. Run `/update` to download and run the same
checksum-verifying hosted installer, then restart p2pchat. Set
`P2PCHAT_DISABLE_UPDATE_CHECK=1` to disable the automatic startup check;
`/update` still works when invoked explicitly.

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
- Image transfers are negotiated as an optional protocol feature and split into
  small chunks; every chunk passes through the same Signal Double Ratchet as
  text messages. The relay never receives image plaintext.
- Video-call capability is negotiated separately. Call signaling stays inside
  Signal ciphertext, while short-lived TURN credentials are issued only to the
  two authenticated relay roles for that chat.
- Audio and video use mandatory TURN with WebRTC DTLS-SRTP. Production defaults
  to Cloudflare TURN; free local development can use self-hosted Coturn. The
  selected relay can route packets but cannot decrypt the media.
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
- Image content and image metadata, including filenames and MIME types, are
  stored in separate AES-256-GCM envelopes. Only attachment byte length and the
  same message-routing metadata described below remain visible in SQLite.
- Reply relationships are carried inside Signal ciphertext and stored as
  AES-256-GCM ciphertext; the quoted text is derived locally from message
  history rather than duplicated in the protocol or database.
- Profile directories use owner-only permissions on supported operating
  systems, and SQLite secure deletion is enabled.
- Received messages are stripped of terminal control and bidirectional override
  characters before display.
- The video-call HTTP bridge binds only to `127.0.0.1`, requires a random
  per-window bearer token, serves a restrictive Content Security Policy, and is
  closed when the call ends.

The database is not fully opaque: timestamps, delivery state, sequence numbers,
public keys, and peer identifiers remain visible. The rendezvous and TURN
operators can observe IP addresses, timing, room locators, call timing, and
ciphertext sizes. A compromised unlocked device, administrator access, malware,
backups, filesystem snapshots, or an exposed/weak profile password can defeat
local protection.

The optional startup update check contacts the p2pchat release service, which
can observe the request IP address. Archive downloads also reveal the operating
system and CPU family through the requested filename. Neither request sends
chat, profile, identity, or database data.

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

### Free local video-call test

Docker is the only additional requirement. Coturn is open source, runs only on
localhost in this setup, and uses a generated shared secret stored in ignored
owner-only files. No Cloudflare Realtime subscription or TURN key is required.

Start Coturn and the local relay Worker:

```sh
corepack pnpm relay:dev:free
```

Then start two clients in separate terminals:

```sh
P2PCHAT_RELAY_URL=http://127.0.0.1:8787 \
  corepack pnpm dev --profile alice
```

```sh
P2PCHAT_RELAY_URL=http://127.0.0.1:8787 \
  corepack pnpm dev --profile bob
```

Create an Internet invite locally with `/new`, join it from the other terminal,
and run `/call`. Stop Coturn afterward with:

```sh
corepack pnpm turn:down
```

This localhost configuration is for two clients on the same computer. Testing
from different internet connections still requires one publicly reachable TURN
server. You can run the same Coturn image on a server or a port-forwarded
machine, expose TCP/UDP 3478 and the configured UDP relay range, set its public
`external-ip`, and place the resulting `turn:`/`turns:` URLs in `COTURN_URLS`.

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

## Distribution

Customer installation and `/update` do not use npm. Build the four macOS/Linux
x64/arm64 runtime archives, their SHA-256 manifest, and the corresponding source
archive with:

```sh
corepack pnpm distribution:build
```

Generated artifacts are written to the ignored `release/` directory. Production
stores them in the private `p2pchat-releases` R2 bucket; the relay Worker streams
only validated, versioned archive names through `/downloads/`. Upload versioned
archives first and `latest.json` last so clients never observe a partially
published release.

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

The production Cloudflare provider requires a Cloudflare Realtime TURN key.
Keep both values in Worker secrets; never add them to `wrangler.jsonc` or source
control:

```sh
corepack pnpm --dir relay exec wrangler secret put TURN_KEY_ID
corepack pnpm --dir relay exec wrangler secret put TURN_KEY_API_TOKEN
```

For local relay development, copy `relay/.dev.vars.example` to
`relay/.dev.vars` and replace the placeholders. The real file is ignored by
Git.

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
