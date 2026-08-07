import {
  CombinedAutocompleteProvider,
  Key,
  matchesKey,
  type SlashCommand,
} from '@earendil-works/pi-tui';

export type UiAction =
  | Readonly<{ kind: 'clear' }>
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'join'; code: string | null }>
  | Readonly<{ kind: 'message'; body: string }>
  | Readonly<{ kind: 'new-chat' }>
  | Readonly<{ kind: 'new-local-chat' }>
  | Readonly<{ kind: 'license' }>
  | Readonly<{ kind: 'quit' }>
  | Readonly<{ kind: 'source' }>
  | Readonly<{ kind: 'update' }>;

export const UI_COMMAND_SUGGESTIONS = [
  { name: 'new', description: 'Create an Internet chat' },
  { name: 'new-local', description: 'Create a direct LAN chat' },
  {
    name: 'join',
    description: 'Join using an invite code',
    argumentHint: '<code>',
  },
  { name: 'help', description: 'Show all commands' },
  { name: 'clear', description: 'Clear the activity panel' },
  { name: 'update', description: 'Install the latest p2pchat version' },
  { name: 'source', description: 'Show the exact release source' },
  { name: 'license', description: 'Show licensing information' },
  { name: 'quit', description: 'Exit safely' },
] as const satisfies readonly SlashCommand[];

export function createUiAutocompleteProvider(
  basePath: string,
): CombinedAutocompleteProvider {
  return new CombinedAutocompleteProvider(
    [...UI_COMMAND_SUGGESTIONS],
    basePath,
  );
}

export function isQuitSubmission(
  input: string,
  terminalInput: string,
): boolean {
  const isEnter =
    terminalInput === '\r' ||
    terminalInput === '\n' ||
    matchesKey(terminalInput, Key.enter) ||
    matchesKey(terminalInput, Key.return);

  return isEnter && parseUiCommand(input)?.kind === 'quit';
}

export function parseUiCommand(input: string): UiAction | null {
  const value = input.trim();

  if (value.length === 0) {
    return null;
  }

  if (!value.startsWith('/')) {
    return { kind: 'message', body: value };
  }

  const firstSpace = value.indexOf(' ');
  const command = firstSpace === -1 ? value : value.slice(0, firstSpace);
  const argument = firstSpace === -1 ? '' : value.slice(firstSpace + 1).trim();

  switch (command.toLowerCase()) {
    case '/clear':
      return { kind: 'clear' };
    case '/help':
      return { kind: 'help' };
    case '/join':
      return { kind: 'join', code: argument.length > 0 ? argument : null };
    case '/license':
      return { kind: 'license' };
    case '/new':
      return { kind: 'new-chat' };
    case '/new-local':
      return { kind: 'new-local-chat' };
    case '/quit':
    case '/exit':
      return { kind: 'quit' };
    case '/source':
      return { kind: 'source' };
    case '/update':
      return { kind: 'update' };
    default:
      return { kind: 'help' };
  }
}
