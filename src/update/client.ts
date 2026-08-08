import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

const LATEST_RELEASE_URL =
  'https://p2pchat-relay.sathuashrith.com/downloads/latest.json';
const INSTALLER_URL = 'https://p2pchat-relay.sathuashrith.com/install.sh';
const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_INSTALLER_BYTES = 64 * 1024;

const packageMetadataSchema = z.object({
  version: z.string(),
});

interface ParsedVersion {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[] | null;
}

export interface UpdateStatus {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly updateAvailable: boolean;
}

export interface UpdateCheckOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

export type InstallerCommandRunner = (
  executable: string,
  arguments_: readonly string[],
) => Promise<void>;

export interface UpdateInstallOptions {
  readonly fetch?: typeof fetch;
  readonly platform?: NodeJS.Platform;
  readonly runner?: InstallerCommandRunner;
}

export async function checkForUpdate(
  currentVersion: string,
  options: UpdateCheckOptions = {},
): Promise<UpdateStatus> {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutSignal = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
  const signal =
    options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
  const response = await fetchImplementation(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    throw new Error(`Release service returned HTTP ${String(response.status)}`);
  }
  const metadata = packageMetadataSchema.parse(await response.json());
  return {
    currentVersion,
    latestVersion: metadata.version,
    updateAvailable:
      compareSemanticVersions(metadata.version, currentVersion) > 0,
  };
}

export async function installLatestRelease(
  options: UpdateInstallOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error('Automatic updates are supported only on macOS and Linux');
  }

  const fetchImplementation = options.fetch ?? fetch;
  const response = await fetchImplementation(INSTALLER_URL, {
    headers: { Accept: 'text/x-shellscript' },
    redirect: 'error',
    signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Installer service returned HTTP ${String(response.status)}`,
    );
  }
  const contentLength = response.headers.get('Content-Length');
  if (
    contentLength !== null &&
    Number.parseInt(contentLength, 10) > MAX_INSTALLER_BYTES
  ) {
    throw new Error('Installer response is too large');
  }
  const script = await response.text();
  if (Buffer.byteLength(script, 'utf8') > MAX_INSTALLER_BYTES) {
    throw new Error('Installer response is too large');
  }
  if (!script.startsWith('#!/bin/sh\nset -eu\n')) {
    throw new Error('Installer service returned an invalid script');
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'p2pchat-update-'));
  const installerPath = join(temporaryDirectory, 'install.sh');
  try {
    await writeFile(installerPath, script, { mode: 0o700 });
    await (options.runner ?? runInstallerCommand)('sh', [installerPath]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function compareSemanticVersions(left: string, right: string): number {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);
  for (const index of [0, 1, 2] as const) {
    if (leftVersion.core[index] > rightVersion.core[index]) {
      return 1;
    }
    if (leftVersion.core[index] < rightVersion.core[index]) {
      return -1;
    }
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function parseSemanticVersion(value: string): ParsedVersion {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      value,
    );
  if (match === null) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  return {
    core: [BigInt(major), BigInt(minor), BigInt(patch)],
    prerelease: match[4]?.split('.') ?? null,
  };
}

function comparePrerelease(
  left: readonly string[] | null,
  right: readonly string[] | null,
): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(
      leftIdentifier,
      rightIdentifier,
    );
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftIsNumber = /^\d+$/u.test(left);
  const rightIsNumber = /^\d+$/u.test(right);
  if (leftIsNumber && rightIsNumber) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber > rightNumber ? 1 : leftNumber < rightNumber ? -1 : 0;
  }
  if (leftIsNumber) {
    return -1;
  }
  if (rightIsNumber) {
    return 1;
  }
  return left > right ? 1 : left < right ? -1 : 0;
}

function runInstallerCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...arguments_],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: UPDATE_INSTALL_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve();
          return;
        }
        const detail = stderr.trim();
        reject(
          new Error(
            detail.length > 0
              ? `p2pchat installer failed: ${detail}`
              : 'p2pchat installer failed',
            { cause: error },
          ),
        );
      },
    );
  });
}
