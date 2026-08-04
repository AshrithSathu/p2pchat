import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveDataDirectory(): string {
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
