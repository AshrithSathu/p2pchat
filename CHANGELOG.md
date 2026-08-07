# Changelog

All notable changes to p2pchat are documented here.

## [0.6.0](https://github.com/AshrithSathu/p2pchat/compare/v0.5.0...v0.6.0) (2026-08-07)

### Features

- add encrypted images and message replies ([#4](https://github.com/AshrithSathu/p2pchat/issues/4)) ([8bce453](https://github.com/AshrithSathu/p2pchat/commit/8bce45378b532a83484e50e74846ab9c2dea4233))
- add hosted install script ([29ee0eb](https://github.com/AshrithSathu/p2pchat/commit/29ee0ebe3b6144569921052eece099a3b3366bab))
- add landing site and repository safeguards ([19412c8](https://github.com/AshrithSathu/p2pchat/commit/19412c8614ab8cd001b830eab4d89fdab92c03d0))
- redesign landing page ([76d2f5c](https://github.com/AshrithSathu/p2pchat/commit/76d2f5cedcaa4bff533692b4c786240bd126bf7f))

### Bug Fixes

- bound landing layout on large screens ([9366e4d](https://github.com/AshrithSathu/p2pchat/commit/9366e4dc0e2e24f73bf59e971646b6169aeaf0f1))
- configure pnpm package registry ([0cc7cc4](https://github.com/AshrithSathu/p2pchat/commit/0cc7cc4944535dc7d755f7fa94b7442ad8fd7633))
- override package publish target ([e4744b1](https://github.com/AshrithSathu/p2pchat/commit/e4744b14ebf5a3e6b20ee38c09b59252e3ee41bb))
- target GitHub package registry ([c799ca3](https://github.com/AshrithSathu/p2pchat/commit/c799ca381fcdcfc59a0b1dab5822cb6fcc3ef374))

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
