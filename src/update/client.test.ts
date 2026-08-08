import { access, readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  checkForUpdate,
  compareSemanticVersions,
  installLatestRelease,
} from './client.js';

describe('update client', () => {
  it('detects newer stable versions from typed release metadata', async () => {
    const fetchLatest: typeof fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ version: '1.2.0' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(
      checkForUpdate('1.1.9', { fetch: fetchLatest }),
    ).resolves.toEqual({
      currentVersion: '1.1.9',
      latestVersion: '1.2.0',
      updateAvailable: true,
    });
    expect(fetchLatest).toHaveBeenCalledOnce();
  });

  it('does not downgrade and rejects invalid release versions', async () => {
    const sameVersion: typeof fetch = async () =>
      Promise.resolve(new Response(JSON.stringify({ version: '2.0.0' })));
    await expect(
      checkForUpdate('2.0.0', { fetch: sameVersion }),
    ).resolves.toMatchObject({ updateAvailable: false });

    const invalidVersion: typeof fetch = async () =>
      Promise.resolve(new Response(JSON.stringify({ version: 'latest' })));
    await expect(
      checkForUpdate('2.0.0', { fetch: invalidVersion }),
    ).rejects.toThrow('Invalid semantic version');
  });

  it('compares prereleases according to semantic version precedence', () => {
    expect(compareSemanticVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareSemanticVersions('2.0.0', '10.0.0')).toBe(-1);
    expect(compareSemanticVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareSemanticVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
  });

  it('downloads the hosted installer and executes its exact file with sh', async () => {
    const calls: { executable: string; arguments_: readonly string[] }[] = [];
    const script = '#!/bin/sh\nset -eu\nprintf test\n';
    let installerPath = '';
    await installLatestRelease({
      platform: 'linux',
      fetch: async () => new Response(script),
      runner: async (executable, arguments_) => {
        calls.push({ executable, arguments_ });
        installerPath = arguments_[0] ?? '';
        await expect(readFile(installerPath, 'utf8')).resolves.toBe(script);
      },
    });

    expect(calls).toEqual([{ executable: 'sh', arguments_: [installerPath] }]);
    await expect(access(installerPath)).rejects.toThrow();
  });
});
