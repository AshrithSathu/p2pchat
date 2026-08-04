export type CliCommand =
  | Readonly<{ kind: 'app' }>
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'version' }>;

export function parseArguments(argv: readonly string[]): CliCommand {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { kind: 'help' };
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    return { kind: 'version' };
  }

  return { kind: 'app' };
}
