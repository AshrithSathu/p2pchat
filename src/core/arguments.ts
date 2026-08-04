import { DEFAULT_PROFILE_NAME, normalizeProfileName } from './profile.js';

export type CliCommand =
  | Readonly<{ kind: 'app'; profileName: string }>
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'version' }>;

export function parseArguments(argv: readonly string[]): CliCommand {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { kind: 'help' };
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    return { kind: 'version' };
  }

  let profileName = DEFAULT_PROFILE_NAME;
  let profileSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }

    const inlineProfile = /^(?:--profile|--user)=(.+)$/u.exec(argument)?.[1];
    if (inlineProfile !== undefined) {
      if (profileSpecified) {
        throw new Error('Profile can only be specified once.');
      }
      profileName = normalizeProfileName(inlineProfile);
      profileSpecified = true;
      continue;
    }

    if (
      argument === '--profile' ||
      argument === '--user' ||
      argument === '-p'
    ) {
      if (profileSpecified) {
        throw new Error('Profile can only be specified once.');
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`Missing profile name after ${argument}.`);
      }
      profileName = normalizeProfileName(value);
      profileSpecified = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return { kind: 'app', profileName };
}
