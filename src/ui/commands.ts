export type UiAction =
  | Readonly<{ kind: 'clear' }>
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'join'; code: string | null }>
  | Readonly<{ kind: 'message'; body: string }>
  | Readonly<{ kind: 'new-chat' }>
  | Readonly<{ kind: 'new-local-chat' }>
  | Readonly<{ kind: 'license' }>
  | Readonly<{ kind: 'quit' }>
  | Readonly<{ kind: 'source' }>;

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
    default:
      return { kind: 'help' };
  }
}
