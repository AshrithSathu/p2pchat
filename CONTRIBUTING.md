# Contributing to p2pchat

Thank you for helping improve p2pchat. Security, interoperability, and clear
failure behavior take priority over adding features quickly.

## Development setup

Requirements:

- Node.js 22 or newer
- Corepack

```sh
git clone https://github.com/AshrithSathu/p2pchat.git
cd p2pchat
corepack enable
corepack pnpm install --frozen-lockfile
```

Dependencies must be changed through pnpm commands rather than by manually
editing package dependency fields.

## Validate a change

```sh
corepack pnpm check
corepack pnpm build
```

Add focused tests for changed behavior. Network, authentication, storage, and
cryptographic changes should include failure-path and tamper tests where
applicable.

## Pull requests

- Keep changes focused and explain their security impact.
- Do not commit databases, invite codes, passwords, private keys, tokens, or
  real message content.
- Update `README.md`, `CHANGELOG.md`, and `SECURITY.md` when behavior or risk
  changes.
- Confirm that Linux, macOS, and Windows CI pass.

## Vulnerabilities

Do not open a public issue for a suspected vulnerability. Follow the private
reporting process in [SECURITY.md](SECURITY.md).
