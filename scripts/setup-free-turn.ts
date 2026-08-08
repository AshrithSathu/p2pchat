import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const coturnEnvironmentPath = join(projectRoot, 'dev/coturn/.env');
const relayEnvironmentPath = join(projectRoot, 'relay/.dev.vars');

const coturnValues = parseEnvironment(
  await readOptionalFile(coturnEnvironmentPath),
);
const relayValues = parseEnvironment(
  await readOptionalFile(relayEnvironmentPath),
);
const configuredProvider = relayValues.get('TURN_PROVIDER');
if (configuredProvider !== undefined && configuredProvider !== 'coturn') {
  throw new Error(
    'relay/.dev.vars is configured for another TURN provider; move it aside before enabling free local Coturn',
  );
}

const coturnSecret = coturnValues.get('COTURN_SHARED_SECRET');
const relaySecret = relayValues.get('COTURN_SHARED_SECRET');
if (
  coturnSecret !== undefined &&
  relaySecret !== undefined &&
  coturnSecret !== relaySecret
) {
  throw new Error(
    'Local Coturn and relay secrets do not match; remove both ignored environment files and run setup again',
  );
}
const sharedSecret =
  coturnSecret ?? relaySecret ?? randomBytes(32).toString('base64url');

await writePrivateFile(
  coturnEnvironmentPath,
  `COTURN_SHARED_SECRET=${sharedSecret}\n`,
);
await writePrivateFile(
  relayEnvironmentPath,
  [
    'TURN_PROVIDER=coturn',
    `COTURN_SHARED_SECRET=${sharedSecret}`,
    'COTURN_URLS=turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp',
    'TURN_KEY_ID=unused-by-local-coturn',
    'TURN_KEY_API_TOKEN=unused-by-local-coturn',
    '',
  ].join('\n'),
);

console.log(
  'Free local TURN configuration is ready. Secrets were written to ignored owner-only files.',
);

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function parseEnvironment(source: string | null): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of source?.split(/\r?\n/gu) ?? []) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const equals = trimmed.indexOf('=');
    if (equals <= 0) {
      throw new Error('Local TURN environment file contains an invalid line');
    }
    values.set(trimmed.slice(0, equals), trimmed.slice(equals + 1));
  }
  return values;
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}
