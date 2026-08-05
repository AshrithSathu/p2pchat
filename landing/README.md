# Landing page

This directory is intentionally limited to the public website served from
`p2pchat.sathuashrith.com`. Changes here must not alter the terminal client,
relay protocol, cryptography, installer, or package publishing behavior.

The page is a static Cloudflare Workers Assets deployment:

- `public/` contains the HTML, CSS, security headers, and generated browser JS.
- `src/app.ts` contains the small, strictly typed copy-button enhancement.
- `wrangler.jsonc` owns only the landing site's deployment configuration.

## Local development

From the repository root:

```sh
corepack pnpm landing:dev
```

## Validation and deployment

```sh
corepack pnpm landing:check
corepack pnpm landing:deploy
```

The installer displayed by this page remains hosted by the separate relay
Worker at `p2pchat-relay.sathuashrith.com/install.sh`.
