import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveProfileDataDirectory } from './paths.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('profile data directories', () => {
  it('isolates normalized named profiles below one data root', async () => {
    const root = await temporaryDirectory();
    await expect(resolveProfileDataDirectory('Alice', root)).resolves.toBe(
      join(root, 'profiles', 'alice'),
    );
    await expect(resolveProfileDataDirectory('Bob', root)).resolves.toBe(
      join(root, 'profiles', 'bob'),
    );
  });

  it('keeps an existing legacy database mapped to the default profile', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, 'chat.db'), new Uint8Array());
    await expect(resolveProfileDataDirectory('default', root)).resolves.toBe(
      root,
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'p2pchat-profile-path-'));
  directories.push(directory);
  return directory;
}
