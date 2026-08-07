import { execFile } from 'node:child_process';

import { z } from 'zod';

const PACKAGE_NAME = '@ashrithsathu/p2pchat';
const LATEST_PACKAGE_URL =
  'https://registry.npmjs.org/@ashrithsathu%2Fp2pchat/latest';
const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_INSTALL_TIMEOUT_MS = 5 * 60_000;

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

export type PackageCommandRunner = (
  executable: string,
  arguments_: readonly string[],
) => Promise<void>;

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
  const response = await fetchImplementation(LATEST_PACKAGE_URL, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${String(response.status)}`);
  }
  const metadata = packageMetadataSchema.parse(await response.json());
  return {
    currentVersion,
    latestVersion: metadata.version,
    updateAvailable:
      compareSemanticVersions(metadata.version, currentVersion) > 0,
  };
}

export async function installLatestPackage(
  runner: PackageCommandRunner = runPackageCommand,
): Promise<void> {
  await runner(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'install',
    '--global',
    '--no-audit',
    '--no-fund',
    `${PACKAGE_NAME}@latest`,
  ]);
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

function runPackageCommand(
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
              ? `npm could not update p2pchat: ${detail}`
              : 'npm could not update p2pchat',
            { cause: error },
          ),
        );
      },
    );
  });
}
