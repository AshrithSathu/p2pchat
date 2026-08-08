import { z } from 'zod';

const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const artifactFilenamePattern =
  /^p2pchat-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)|source)\.tar\.gz$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export const releasePlatforms = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
] as const;

const releaseArtifactSchema = z.object({
  filename: z.string().regex(artifactFilenamePattern),
  sha256: z.string().regex(sha256Pattern),
  bytes: z.number().int().positive(),
});

export const releaseManifestSchema = z.object({
  version: z.string().regex(semanticVersionPattern),
  releasedAt: z.iso.datetime(),
  artifacts: z.object({
    'darwin-arm64': releaseArtifactSchema,
    'darwin-x64': releaseArtifactSchema,
    'linux-arm64': releaseArtifactSchema,
    'linux-x64': releaseArtifactSchema,
  }),
  source: releaseArtifactSchema,
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type ReleasePlatform = (typeof releasePlatforms)[number];

const LATEST_MANIFEST_KEY = 'releases/latest.json';
const MAX_MANIFEST_BYTES = 16 * 1024;

export async function loadLatestRelease(
  releases: R2Bucket,
): Promise<ReleaseManifest> {
  const object = await releases.get(LATEST_MANIFEST_KEY);
  if (object === null) {
    throw new Error('No p2pchat release is available');
  }
  if (object.size > MAX_MANIFEST_BYTES) {
    throw new Error('Release manifest is too large');
  }
  return releaseManifestSchema.parse(await object.json<unknown>());
}

export async function distributionResponse(
  request: Request,
  releases: R2Bucket,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed\n', {
      status: 405,
      headers: {
        Allow: 'GET, HEAD',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const { pathname } = new URL(request.url);
  if (pathname === '/downloads/latest.json') {
    const manifest = await loadLatestRelease(releases);
    return Response.json(manifest, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (pathname === '/downloads/source.tar.gz') {
    const manifest = await loadLatestRelease(releases);
    return Response.redirect(
      new URL(`/downloads/${manifest.source.filename}`, request.url).toString(),
      302,
    );
  }

  const match = /^\/downloads\/([^/]+)$/u.exec(pathname);
  const filename = match?.[1];
  if (filename === undefined || !artifactFilenamePattern.test(filename)) {
    return new Response('Not found\n', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const key = `releases/${filename}`;
  if (request.method === 'HEAD') {
    const object = await releases.head(key);
    if (object === null) {
      return notFoundResponse();
    }
    return new Response(null, { headers: artifactHeaders(object, filename) });
  }

  const object = await releases.get(key, { onlyIf: request.headers });
  if (object === null) {
    return notFoundResponse();
  }

  const headers = artifactHeaders(object, filename);
  if (!('body' in object)) {
    return new Response(null, { status: 412, headers });
  }
  return new Response(object.body, { headers });
}

function notFoundResponse(): Response {
  return new Response('Not found\n', {
    status: 404,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function artifactHeaders(object: R2Object, filename: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Content-Length', String(object.size));
  headers.set('Content-Type', 'application/gzip');
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}
