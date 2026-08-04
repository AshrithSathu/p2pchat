# p2pchat v0.4.0

A private, local-first, peer-to-peer terminal chat written in strict TypeScript.
It connects across ordinary NAT and firewall boundaries through an opaque
Cloudflare WebSocket relay while keeping identities, keys, and messages
end-to-end encrypted.

## Requirements

- Node.js 22 or newer
- Corepack (included with standard Node.js installations)

Dependencies are managed only through the pinned `pnpm@11.4.0` package manager.

## Install the private release

Until the repository is made public, authenticate GitHub CLI and download the
release package:

```sh
gh release download v0.4.0 \
  --repo AshrithSathu/p2pchat \
  --pattern 'p2p-chat-0.4.0.tgz'
corepack pnpm add --global \
  --allow-build=better-sqlite3 \
  --allow-build=@signalapp/libsignal-client \
  ./p2p-chat-0.4.0.tgz
p2pchat --profile alice
```

The release also contains a SHA-256 checksum file. The package installs the
correct prebuilt libsignal and SQLite native libraries for the current system.

## Run it

```sh
corepack pnpm install
corepack pnpm dev
```

Each profile has its own password, database, Ed25519 identity, Signal identity,
ratchet state, peers, and message history. Opening a profile name for the first
time creates it and asks for that profile's password:

```sh
corepack pnpm dev -- --profile alice
# Installed release:
p2pchat --profile alice
```

Profile names are case-insensitive and may contain 1-32 letters, numbers, `_`,
or `-`. The global `P2PCHAT_PASSPHRASE` override is intentionally unsupported;
passwords are entered per profile through the hidden terminal prompt.

To test two local users, open the same data root with different profile names:

```sh
# Terminal 1
P2PCHAT_DATA_DIR=/tmp/p2pchat-dev corepack pnpm dev -- --profile alice

# Terminal 2
P2PCHAT_DATA_DIR=/tmp/p2pchat-dev corepack pnpm dev -- --profile bob
```

Then:

1. Type `/` to open the command menu, then select `/new` in Terminal 1.
2. Copy the short one-time Internet code.
3. Select `/join` in Terminal 2 and paste the code.
4. Compare the safety number shown on both screens over a trusted channel.
5. Type messages normally. `✓✓` means the peer acknowledged receipt.

Running without `--profile` opens `default`. An existing pre-profile database is
automatically retained as that default profile.

Type `/` to open autocomplete for every action. Continue typing to fuzzy-filter
the list, use Up/Down to select, Tab to insert without running, Enter to run the
selected action, and Escape to close the menu. Use `/help` for all commands,
`/source` for the exact corresponding source, `/license` for licensing
information, and `/quit` for a clean shutdown.

`/new` uses the deployed Internet relay. `/new-local` retains the original
direct TCP mode for peers on the same reachable LAN. A custom relay can be
selected with `P2PCHAT_RELAY_URL=https://your-worker.example`.

## Release checks

```sh
corepack pnpm check
corepack pnpm build
corepack pnpm start
```

`check` validates both the terminal client and Cloudflare Worker. It runs strict
TypeScript validation, ESLint, client tests, the official Workers-runtime
Durable Object test, formatting checks, generated binding types, and a Wrangler
deployment dry run.

## Security model

- Each authenticated connection is upgraded with the official, exact-pinned
  `@signalapp/libsignal-client@0.99.3` implementation. A fresh classical
  one-time prekey, signed prekey, and Kyber prekey establish a PQXDH session;
  every application frame after setup is a Double Ratchet message.
- Double Ratchet gives each message a unique key and provides forward-secrecy
  and post-compromise-recovery properties as its chains advance. Replayed,
  reordered, and tampered frames are handled by libsignal; prekey frames are
  rejected after setup.
- Signal identity keys are pinned to the authenticated Ed25519 peer identity.
  A changed Signal identity is rejected, and the displayed safety number covers
  both peers' Ed25519 and Signal identity keys.
- Noise encrypts each live direct libp2p connection. The Signal layer remains
  active inside Noise as defense in depth.
- Internet sessions perform a code-protected Ed25519/X25519 handshake and derive
  fresh directional AES-256-GCM keys. Signal messages run inside that encrypted
  channel, so the Cloudflare relay only sees opaque ciphertext.
- Long-term Ed25519 keys mutually authenticate app identities.
- A one-time secret authenticates each invite; invites expire and cannot be
  reused after a successful connection.
- A safety number lets people detect an identity mismatch out of band.
- Message bodies, private identities, prekeys, trusted peer identities, and
  ratchet sessions are AES-256-GCM encrypted in local SQLite with a key derived
  using scrypt. SQLite secure deletion and a non-persistent rollback journal
  reduce recoverable stale key material.
- Received text is stripped of terminal control and bidirectional override
  characters before it is displayed.

Database metadata such as timestamps, delivery state, and peer identifiers is
not encrypted. Filesystem snapshots, backups, flash wear-leveling, a compromised
unlocked device, or an exposed passphrase can defeat local key-erasure
expectations. Cloudflare can still observe IP addresses, timing, room locators,
and ciphertext sizes.

This is a production-hardened release candidate, not an audited security
product. It has not received an independent cryptographic or application
security audit. Do not make high-risk safety claims or deploy it for vulnerable
users until that review and its findings are complete.

The libsignal package is AGPL-3.0-only, so the terminal client is also licensed
under AGPL-3.0-only. Signal states that use of libsignal outside Signal is
unsupported and its APIs may change without notice; this release pins the exact
reviewed version and is not affiliated with Signal. The separately deployed
Cloudflare relay remains MIT-licensed and does not link libsignal.

## Internet relay

The deployed relay is:

```text
https://p2pchat-relay.sathuashrith.com
```

Each invite gets a separate SQLite-backed Durable Object. Cloudflare stores only
an encrypted invite envelope, token hashes, and short-lived connection tickets.
It does not store messages. Rooms expire automatically after at most 15 minutes,
and an invite stops issuing tickets after both roles have connected.

Cloudflare can observe network metadata such as IP addresses, timing, frame
sizes, and the opaque room locator. It cannot decrypt the invite, peer identities,
or chat frames. The software has not received an independent security audit.

To exercise the full client protocol against the deployed relay:

```sh
P2PCHAT_LIVE_RELAY_TEST=1 corepack pnpm exec vitest run \
  src/relay/live.integration.test.ts
```

Relay development and deployment commands:

```sh
corepack pnpm relay:dev
corepack pnpm relay:test
corepack pnpm relay:deploy
```
