import {
  Box,
  Container,
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  type EditorTheme,
  type SelectListTheme,
} from '@earendil-works/pi-tui';

import { ChatSession, type ChatEvent } from '../chat/session.js';
import {
  P2PService,
  type AuthenticatedSession,
  type InviteHandle,
} from '../network/service.js';
import { sanitizeTerminalText } from '../security/message-body.js';
import { resolveRelayEndpoint } from '../relay/config.js';
import { RelayService } from '../relay/service.js';
import {
  LocalStore,
  type LocalIdentity,
  type StoredMessage,
} from '../storage/local-store.js';
import { resolveDataDirectory } from '../storage/paths.js';
import { obtainPassphrase } from '../storage/unlock.js';
import { ansi } from './ansi.js';
import { parseUiCommand, type UiAction } from './commands.js';

const selectListTheme: SelectListTheme = {
  selectedPrefix: ansi.cyan,
  selectedText: ansi.bold,
  description: ansi.dim,
  scrollInfo: ansi.dim,
  noMatch: ansi.yellow,
};

const editorTheme: EditorTheme = {
  borderColor: ansi.cyan,
  selectList: selectListTheme,
};

const HELP_TEXT = `${ansi.bold('Commands')}
${ansi.cyan('/new')}          Create an Internet chat
${ansi.cyan('/new-local')}    Create a direct LAN chat
${ansi.cyan('/join <code>')}  Join using an invite code
${ansi.cyan('/clear')}        Clear this activity panel
${ansi.cyan('/source')}       Show the exact release source
${ansi.cyan('/license')}      Show licensing information
${ansi.cyan('/quit')}         Exit safely`;

const SOURCE_URL = 'https://github.com/AshrithSathu/p2pchat/tree/v0.3.0';
const LICENSE_URL =
  'https://github.com/AshrithSathu/p2pchat/blob/v0.3.0/LICENSE';

interface LayoutHandle {
  readonly root: Container;
  close(): Promise<void>;
}

function createLayout(
  tui: TUI,
  finish: () => void,
  identity: LocalIdentity,
  getDirectNetwork: () => Promise<P2PService>,
  relay: RelayService | null,
  store: LocalStore,
): LayoutHandle {
  const root = new Container();
  const header = new Box(1, 1);
  const activity = new Text('', 1, 0);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  let currentSession: AuthenticatedSession | null = null;
  let currentChat: ChatSession | null = null;
  let pendingInvite: InviteHandle | null = null;
  let disconnectedReason: string | null = null;

  header.addChild(
    new Text(
      `${ansi.bold(ansi.cyan('p2pchat'))} ${ansi.dim('v0.3.0')}\n${ansi.dim(
        'private • local-first • end-to-end encrypted',
      )}\n${ansi.dim(`identity ${identity.fingerprint.slice(0, 24)}…`)}`,
    ),
  );

  const showWelcome = (): void => {
    activity.setText(
      `${ansi.green('● ready')}  No peer connected\n\n` +
        `${ansi.bold('Start a conversation')}\n` +
        `Create an Internet invitation with ${ansi.cyan('/new')}, or join one with ` +
        `${ansi.cyan('/join <code>')}.\n\n${ansi.dim(
          'Messages will be kept on this device only.',
        )}`,
    );
    tui.requestRender();
  };

  const formatMessage = (message: StoredMessage): string => {
    const fromSelf = message.senderPeerId === identity.id;
    const author = fromSelf ? ansi.cyan('you') : ansi.green('peer');
    const time = new Date(message.sentAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const state =
      message.deliveryState === 'pending'
        ? ansi.dim(' …')
        : message.deliveryState === 'sent'
          ? ansi.dim(' ✓')
          : message.deliveryState === 'delivered'
            ? ansi.green(' ✓✓')
            : '';
    const body = message.body.replaceAll('\n', '\n    ');
    return `${ansi.dim(time)} ${author}${state}\n    ${body}`;
  };

  const renderChat = (): void => {
    if (currentSession === null || currentChat === null) {
      showWelcome();
      return;
    }

    const messages = currentChat.history(100);
    const connectionLine =
      disconnectedReason === null
        ? currentSession.transport === 'relay'
          ? `${ansi.green('● authenticated')}  Internet relay • end-to-end encrypted`
          : `${ansi.green('● authenticated')}  Direct Noise-encrypted connection`
        : `${ansi.red('● disconnected')}  ${sanitizeTerminalText(
            disconnectedReason,
            160,
          )}`;
    const history =
      messages.length === 0
        ? ansi.dim('No messages yet. Say hello.')
        : messages.map(formatMessage).join('\n\n');
    activity.setText(
      `${connectionLine}\n` +
        `${ansi.dim(`peer ${currentSession.peer.fingerprint.slice(0, 24)}…`)}\n\n` +
        `${ansi.bold('Safety number')}  ${ansi.cyan(currentSession.safetyNumber)}\n` +
        `${ansi.yellow('Compare it with your peer before sharing secrets.')}\n\n` +
        history,
    );
    tui.requestRender();
  };

  const onChatEvent = (event: ChatEvent): void => {
    if (event.kind === 'disconnected') {
      disconnectedReason = event.reason;
    }
    renderChat();
  };

  const showConnected = (session: AuthenticatedSession): void => {
    currentSession = session;
    disconnectedReason = null;
    currentChat = new ChatSession(session, store);
    renderChat();
    void currentChat.run(onChatEvent).catch(() => undefined);
  };

  const showAction = async (action: UiAction): Promise<void> => {
    switch (action.kind) {
      case 'clear':
        if (currentChat === null) {
          showWelcome();
        } else {
          activity.setText(
            `${ansi.green('● authenticated')}  Activity cleared\n\n${ansi.dim(
              'Encrypted history remains on this device. Your next message will restore it.',
            )}`,
          );
          tui.requestRender();
        }
        return;
      case 'help':
        activity.setText(HELP_TEXT);
        break;
      case 'join':
        if (currentChat !== null) {
          activity.setText(
            `${ansi.yellow('Already connected')}\nRestart p2pchat to connect to a different peer.`,
          );
          break;
        }
        if (action.code === null) {
          activity.setText(
            `${ansi.yellow('Invite code required')}\nUse ${ansi.cyan(
              '/join <code>',
            )}.`,
          );
          break;
        }

        activity.setText(
          `${ansi.yellow('Connecting…')}\nValidating the invite and negotiating an encrypted channel.`,
        );
        tui.requestRender();
        showConnected(
          RelayService.isInviteCode(action.code)
            ? await requireRelay(relay).join(action.code)
            : await (await getDirectNetwork()).join(action.code),
        );
        break;
      case 'license':
        activity.setText(
          `${ansi.bold('GNU AGPL v3.0 only')}\n${LICENSE_URL}\n\n` +
            ansi.dim(
              'The separately deployed Cloudflare relay is MIT-licensed.',
            ),
        );
        break;
      case 'message':
        if (currentChat === null) {
          activity.setText(
            `${ansi.yellow('No peer connected')}\nCreate or join a chat before sending a message.`,
          );
          break;
        }
        await currentChat.send(action.body);
        renderChat();
        break;
      case 'new-chat':
        if (currentChat !== null) {
          activity.setText(
            `${ansi.yellow('Already connected')}\nRestart p2pchat to connect to a different peer.`,
          );
          break;
        }
        if (pendingInvite !== null) {
          activity.setText(
            `${ansi.yellow('An invite is already active')}\nShare the code currently displayed or restart the app to cancel it.`,
          );
          break;
        }

        activity.setText(
          `${ansi.yellow('Creating Internet invite…')}\nUploading an opaque encrypted rendezvous record.`,
        );
        tui.requestRender();
        pendingInvite = await requireRelay(relay).createInvite();
        activity.setText(
          `${ansi.green('● waiting for peer')}\n\n` +
            `${ansi.bold('One-time Internet code')}\n${ansi.cyan(
              pendingInvite.code,
            )}\n\n` +
            `${ansi.dim(
              `Expires ${new Date(pendingInvite.expiresAt).toLocaleTimeString()}`,
            )}\n\n` +
            ansi.yellow(
              'Anyone holding this code can request access. Share it privately.',
            ),
        );
        tui.requestRender();
        showConnected(await pendingInvite.connected);
        pendingInvite = null;
        break;
      case 'new-local-chat':
        if (currentChat !== null || pendingInvite !== null) {
          activity.setText(
            `${ansi.yellow('A chat or invite is already active')}\nRestart p2pchat to start a different connection.`,
          );
          break;
        }
        pendingInvite = (await getDirectNetwork()).createInvite();
        activity.setText(
          `${ansi.green('● waiting on LAN')}\n\n` +
            `${ansi.bold('Direct invite code')}\n${ansi.cyan(
              pendingInvite.code,
            )}\n\n` +
            ansi.dim(
              `Expires ${new Date(pendingInvite.expiresAt).toLocaleTimeString()}`,
            ),
        );
        tui.requestRender();
        showConnected(await pendingInvite.connected);
        pendingInvite = null;
        break;
      case 'quit':
        finish();
        return;
      case 'source':
        activity.setText(
          `${ansi.bold('Corresponding source for p2pchat v0.3.0')}\n${SOURCE_URL}`,
        );
        break;
    }

    tui.requestRender();
  };

  editor.onSubmit = (input) => {
    const action = parseUiCommand(input);
    if (action === null) {
      return;
    }

    editor.addToHistory(input);
    editor.setText('');
    void showAction(action).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Unexpected network error';
      pendingInvite = null;
      activity.setText(
        `${ansi.red('Action failed')}\n${sanitizeTerminalText(message, 300)}`,
      );
      tui.requestRender();
    });
  };

  root.addChild(header);
  root.addChild(new Spacer(1));
  root.addChild(activity);
  root.addChild(new Spacer(1));
  root.addChild(new Text(ansi.dim('Type a message or command'), 1, 0));
  root.addChild(editor);
  root.addChild(
    new Text(
      `${ansi.dim('Enter')} submit   ${ansi.dim('Shift+Enter')} newline   ${ansi.dim(
        'Ctrl+C',
      )} quit   ${ansi.dim('/help')} commands`,
      1,
      0,
    ),
  );

  showWelcome();
  tui.setFocus(editor);
  return {
    root,
    close: async () => {
      pendingInvite?.cancel();
      await currentChat?.close();
    },
  };
}

export async function runTerminalApp(): Promise<void> {
  const directory = resolveDataDirectory();
  const passphrase = await obtainPassphrase(directory);
  const store = await LocalStore.open({ directory, passphrase });
  const directNetwork: { service: P2PService | null } = { service: null };
  let relay: RelayService | null = null;

  try {
    const relayEndpoint = resolveRelayEndpoint();
    relay =
      relayEndpoint === null
        ? null
        : new RelayService(store, { endpoint: relayEndpoint });
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);
    const completion = Promise.withResolvers<undefined>();
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      tui.stop();
      terminal.setTitle('');
      completion.resolve(undefined);
    };
    const layoutHandle = createLayout(
      tui,
      finish,
      store.identity,
      async () => {
        directNetwork.service ??= await P2PService.start(store);
        return directNetwork.service;
      },
      relay,
      store,
    );
    tui.addChild(layoutHandle.root);
    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl('c'))) {
        finish();
        return { consume: true };
      }
      return undefined;
    });

    terminal.setTitle('p2pchat');
    tui.start();
    await completion.promise;
    await layoutHandle.close();
    await terminal.drainInput(250, 25);
  } finally {
    relay?.stop();
    if (directNetwork.service !== null) {
      await directNetwork.service.stop();
    }
    store.close();
  }
}

function requireRelay(relay: RelayService | null): RelayService {
  if (relay === null) {
    throw new Error(
      'Internet relay is not configured. Set P2PCHAT_RELAY_URL or use /new-local.',
    );
  }
  return relay;
}
