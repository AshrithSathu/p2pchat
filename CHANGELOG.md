# Changelog

All notable changes to p2pchat are documented here.

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
