#!/usr/bin/env node

import { parseArguments } from './core/arguments.js';
import { runTerminalApp } from './ui/app.js';

const HELP = `p2pchat — private peer-to-peer terminal chat

Usage:
  p2pchat                 Open the terminal interface
  p2pchat --profile NAME  Open or create an isolated local user
  p2pchat --help          Show this help
  p2pchat --version       Show the current version
`;

const VERSION = '0.4.0';

async function main(argv: readonly string[]): Promise<void> {
  const command = parseArguments(argv);

  switch (command.kind) {
    case 'help':
      process.stdout.write(HELP);
      return;
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return;
    case 'app':
      await runTerminalApp(command.profileName);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error: unknown) {
  const message =
    error instanceof Error ? error.message : 'Unknown startup error';
  process.stderr.write(`p2pchat: ${message}\n`);
  process.exitCode = 1;
}
