import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PROFILE_NAME, normalizeProfileName } from '../core/profile.js';

export function resolveDataRootDirectory(): string {
  const override = process.env['P2PCHAT_DATA_DIR'];
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }

  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'p2pchat');
    case 'win32': {
      const localAppData = process.env['LOCALAPPDATA'];
      return join(localAppData ?? homedir(), 'p2pchat');
    }
    default: {
      const xdgDataHome = process.env['XDG_DATA_HOME'];
      return join(xdgDataHome ?? join(homedir(), '.local', 'share'), 'p2pchat');
    }
  }
}

export function resolveDataDirectory(): string {
  return resolveDataRootDirectory();
}

export async function resolveProfileDataDirectory(
  profileName: string,
  rootDirectory: string = resolveDataRootDirectory(),
): Promise<string> {
  const normalized = normalizeProfileName(profileName);
  if (
    normalized === DEFAULT_PROFILE_NAME &&
    (await legacyDatabaseExists(rootDirectory))
  ) {
    return rootDirectory;
  }
  return join(rootDirectory, 'profiles', normalized);
}

async function legacyDatabaseExists(rootDirectory: string): Promise<boolean> {
  try {
    await stat(join(rootDirectory, 'chat.db'));
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
