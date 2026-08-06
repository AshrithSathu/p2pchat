# Releasing p2pchat

## Release flow

1. Merge focused feature and fix pull requests into `develop` using squash
   merges and Conventional Commit titles.
2. When the integration branch is ready, merge a `develop` to `main` pull
   request after all required checks pass.
3. Release Please opens or updates a release pull request against `main`. Review
   the proposed version and generated changelog.
4. Merge the generated release pull request when publication is intended.
5. Merge the automatically opened `main` to `develop` synchronization pull
   request after its checks pass.

The final merge updates `package.json`, `src/core/version.ts`,
`.release-please-manifest.json`, and `CHANGELOG.md`; creates the matching `v*`
tag and GitHub Release; attaches the package tarball and checksum; and publishes
to npm and GitHub Packages. Synchronizing `main` back into `develop` prevents
the next integration pull request from reverting generated version files.

Do not manually edit release versions. To force a specific version, add a
`Release-As: x.y.z` footer to a Conventional Commit on `main`.

## One-time credentials

### Release Please pull requests

Create a fine-grained GitHub personal access token with read/write access to
repository contents, pull requests, and issues. Save it as the Actions secret
`RELEASE_PLEASE_TOKEN`.

The workflow falls back to `GITHUB_TOKEN`, but pull requests created with that
token do not trigger other GitHub Actions workflows. The dedicated token is
therefore required for generated release pull requests to receive the checks
required by branch protection.

### npm trusted publishing

In the settings for `@ashrithsathu/p2pchat` on npm, configure a GitHub Actions
trusted publisher with these exact values:

- Organization or user: `AshrithSathu`
- Repository: `p2pchat`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

The release workflow uses GitHub OIDC, so no long-lived npm token is stored in
the repository. npm automatically records provenance for the public package.
