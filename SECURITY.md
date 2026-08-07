# Security policy

## Supported versions

Only the latest tagged release is supported with security fixes.

| Version | Supported |
| ------- | --------- |
| 0.5.x   | Yes       |
| 0.4.x   | No        |
| Earlier | No        |

## Reporting a vulnerability

Do not disclose an unpatched vulnerability in a public issue. Open a private
[GitHub security advisory](https://github.com/AshrithSathu/p2pchat/security/advisories/new)
with reproduction steps, affected versions, and impact. Avoid including real
chat messages, invite codes, passphrases, identities, or private keys.

## Current assurance level

p2pchat has automated protocol, tamper, replay, persistence, direct-network,
encrypted image-transfer, and deployed-relay tests. It has not received an
independent cryptographic or application security audit. Treat the latest
release as production-hardened, not as an audited security product.

Cloudflare can observe connection metadata, including IP addresses, timing,
room locators, and ciphertext sizes. Local database metadata such as timestamps,
delivery state, peer identifiers, and attachment byte length is not encrypted.
Device compromise, filesystem snapshots, backups, flash wear-leveling, or
passphrase exposure can defeat local key-erasure expectations.
