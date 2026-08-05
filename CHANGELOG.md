# Changelog

All notable changes to p2pchat are documented here.

## Unreleased

### Added

- Version-pinned macOS/Linux installer at
  `https://p2pchat-relay.sathuashrith.com/install.sh`, plus a human-readable
  landing page with inspect-first instructions.
- Tracker-free, single-screen project website at
  `https://p2pchat.sathuashrith.com`, isolated under `landing/` and deployed as
  Cloudflare static assets with strict browser security headers.
- GitHub issue and pull-request templates, CODEOWNERS, Dependabot version
  updates, dependency review, and CodeQL scanning for the public repository.

### Changed

- Reworked the landing page into a typography-led editorial terminal design
  with a matching social preview image.
- Aligned the documented Node.js requirement with the TUI runtime dependency:
  Node.js 22.19 or newer.
- Hardened CI with cancellation of superseded runs, per-job timeouts, manual
  dispatch, and landing-site deployment validation.

## 0.5.0 - 2026-08-05

### Added

- Pi-style slash-command autocomplete with live fuzzy filtering, keyboard
  navigation, command hints, completion, and direct action execution.
- Public npm distribution as the `@ashrithsathu/p2pchat` command-line package.
- Public installation, architecture, security, development, and contribution
  documentation.

### Changed

- Centralized the runtime version and verify it against the npm package version.
- Reduced the published npm tarball to runtime output and essential project
  documentation.

### Fixed

- `/quit` and `/exit` now close cleanly in terminals that encode Enter as a raw
  line feed while the autocomplete menu is active.
- Corrected `pnpm dev` profile examples for pnpm 11 argument forwarding.

## 0.4.0 - 2026-08-04

### Added

- Isolated local profiles selected with `--profile`, `--user`, or `-p`.
- Automatic profile creation with a separate password, database, Ed25519
  identity, Signal identity, ratchet state, peer list, and message history.
- Profile identity binding inside SQLite to prevent opening a database under a
  different local user name.
- Active profile name in the terminal header and window title.

### Changed

- Removed the global `P2PCHAT_PASSPHRASE` environment override. Profile
  passwords are entered through the hidden TTY prompt.
- Preserved existing pre-profile databases as the `default` profile while new
  profiles are stored under the shared data root's `profiles` directory.

## 0.3.0 - 2026-08-04

### Added

- Internet connectivity through the deployed Cloudflare Durable Object relay.
- PQXDH session establishment and per-message Double Ratchet encryption using
  exact-pinned `@signalapp/libsignal-client@0.99.3`.
- Encrypted local persistence for Signal identities, prekeys, trusted remote
  identities, ratchet sessions, messages, and the long-term Ed25519 identity.
- Identity-bound safety numbers, replay rejection, out-of-order message support,
  tamper detection, delivery acknowledgements, and terminal-input sanitization.
- Private installable CLI package and automated GitHub release workflow.

### Infrastructure

- Production relay at `p2pchat-relay.sathuashrith.com`.
- Strict TypeScript, ESLint, Vitest, Cloudflare Workers integration tests, and
  deployment dry runs in CI.

### Security status

- This release is production-hardened but has not received an independent
  security audit. Review `SECURITY.md` before relying on it for sensitive use.
