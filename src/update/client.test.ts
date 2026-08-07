import { describe, expect, it, vi } from 'vitest';

import {
  checkForUpdate,
  compareSemanticVersions,
  installLatestPackage,
} from './client.js';

describe('update client', () => {
  it('detects newer stable versions from typed npm metadata', async () => {
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

  it('does not downgrade and rejects invalid registry versions', async () => {
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

  it('updates through npm without invoking a shell', async () => {
    const calls: { executable: string; arguments_: readonly string[] }[] = [];
    await installLatestPackage(async (executable, arguments_) => {
      calls.push({ executable, arguments_ });
    });

    expect(calls).toEqual([
      {
        executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        arguments_: [
          'install',
          '--global',
          '--no-audit',
          '--no-fund',
          '@ashrithsathu/p2pchat@latest',
        ],
      },
    ]);
  });
});
