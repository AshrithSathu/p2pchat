# Security policy

## Supported versions

Only the latest tagged release is supported with security fixes.

| Version | Supported |
| ------- | --------- |
| 0.7.x   | Yes       |
| 0.6.x   | No        |
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

The rendezvous provider and selected TURN operator can observe connection
metadata, including IP addresses, timing, room locators, call timing, TURN usage,
and ciphertext sizes. Participants do not receive one another's IP address
during TURN-only video calls, but this is not an anonymity guarantee: the relay
operator and each participant's network provider still observe their
connection. Local database metadata such as timestamps, delivery state, peer
identifiers, and attachment byte length is not encrypted. Device compromise,
filesystem snapshots, backups, flash wear-leveling, or passphrase exposure can
defeat local key-erasure expectations.

Video offers and answers are authenticated inside the Signal channel, and media
uses WebRTC DTLS-SRTP over mandatory TURN relay candidates. The client rejects
SDP containing direct candidates and closes the call unless the selected local
and remote candidate types are both `relay`. Media transmission and playback
remain disabled until that verification succeeds. Camera and microphone media
are not stored. Browser compromise, malicious extensions, screen capture,
camera drivers, or an already compromised peer endpoint can still expose call
media.
