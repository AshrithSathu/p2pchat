# Contributing to p2pchat

Thank you for helping improve p2pchat. Security, interoperability, and clear
failure behavior take priority over adding features quickly.

## Development setup

Requirements:

- Node.js 22.19 or newer
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
- Update `README.md` and `SECURITY.md` when behavior or risk changes. Release
  Please generates `CHANGELOG.md` from Conventional Commit messages.
- Confirm that Linux, macOS, and Windows CI pass.

## Branches and commit messages

Open feature and fix pull requests against `develop`. Use squash merges and a
[Conventional Commit](https://www.conventionalcommits.org/) title so automated
versioning can classify the change:

- `fix:` creates a patch release.
- `feat:` creates a minor release.
- `feat!:` or a `BREAKING CHANGE:` footer creates a major release.
- `docs:`, `test:`, `ci:`, and `chore:` do not create a release by themselves.

When `develop` is stable, open a pull request from `develop` to `main`. Merging
that pull request updates the generated Release Please pull request; it does not
publish immediately. Merging the generated release pull request updates
`package.json`, `src/core/version.ts`, and `CHANGELOG.md`, creates the `v*` tag
and GitHub Release, and publishes the npm and GitHub packages.

Maintainer setup and recovery instructions are in
[`.github/RELEASING.md`](.github/RELEASING.md).

## Vulnerabilities

Do not open a public issue for a suspected vulnerability. Follow the private
reporting process in [SECURITY.md](SECURITY.md).
