import {
  Box,
  Container,
  Editor,
  Image,
  Key,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Spacer,
  Text,
  TUI,
  type Component,
  type EditorTheme,
  type OverlayHandle,
  type SelectItem,
  type SelectListTheme,
} from '@earendil-works/pi-tui';

import { ChatSession, type ChatEvent } from '../chat/session.js';
import {
  CallController,
  type CallControllerEvent,
} from '../call/controller.js';
import { APP_TAG, APP_VERSION } from '../core/version.js';
import { loadImageFile, type PreparedImage } from '../image/image.js';
import {
  P2PService,
  type AuthenticatedSession,
  type InviteHandle,
} from '../network/service.js';
import { sanitizeTerminalText } from '../security/message-body.js';
import { resolveRelayEndpoint } from '../relay/config.js';
import { RelayPeerOfflineError, RelayService } from '../relay/service.js';
import {
  LocalStore,
  type LocalIdentity,
  type StoredMessage,
} from '../storage/local-store.js';
import { resolveProfileDataDirectory } from '../storage/paths.js';
import { obtainPassphrase } from '../storage/unlock.js';
import { checkForUpdate, installLatestRelease } from '../update/client.js';
import { ansi } from './ansi.js';
import {
  createUiAutocompleteProvider,
  isQuitSubmission,
  parseUiCommand,
  UI_COMMAND_SUGGESTIONS,
  type UiAction,
} from './commands.js';
import { extractDroppedFilePath, readClipboardContent } from './image-input.js';
import { createReplySelectItems, formatReplyPreview } from './replies.js';

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

const MAX_INLINE_HISTORY_IMAGES = 12;
const MESSAGE_ATTACHMENT_PADDING_X = 5;
const CHAT_IMAGE_MAX_WIDTH = 44;
const CHAT_IMAGE_MAX_HEIGHT = 12;
const PENDING_IMAGE_MAX_WIDTH = 36;
const PENDING_IMAGE_MAX_HEIGHT = 9;
const REPLY_PICKER_MAX_VISIBLE = 8;

class IncomingCallPrompt implements Component {
  public constructor(
    readonly peerFingerprint: string,
    readonly onAccept: () => void,
    readonly onDecline: () => void,
  ) {}

  public render(width: number): string[] {
    void width;
    return [
      ansi.bold(ansi.green('Incoming encrypted video call')),
      '',
      `${ansi.dim('peer')} ${this.peerFingerprint}`,
      ansi.dim('Signal authenticated • mandatory TURN relay'),
      ansi.dim('The peer will not receive your IP address.'),
      '',
      `${ansi.green('Enter')} accept   ${ansi.yellow('Esc')} decline`,
    ];
  }

  public handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      this.onAccept();
    } else if (matchesKey(data, Key.escape)) {
      this.onDecline();
    }
  }

  public invalidate(): void {
    // This prompt has no cached layout state to invalidate.
  }
}

class ReplyPicker implements Component {
  readonly #list: SelectList;

  public constructor(
    items: SelectItem[],
    onSelect: (messageId: string) => void,
    onCancel: () => void,
  ) {
    this.#list = new SelectList(
      items,
      REPLY_PICKER_MAX_VISIBLE,
      selectListTheme,
      {
        minPrimaryColumnWidth: 18,
        maxPrimaryColumnWidth: 24,
      },
    );
    this.#list.onSelect = (item) => {
      onSelect(item.value);
    };
    this.#list.onCancel = onCancel;
  }

  public render(width: number): string[] {
    return [
      ansi.bold('Reply to a message'),
      ansi.dim('↑/↓ choose  ·  Enter select  ·  Esc cancel'),
      '',
      ...this.#list.render(width),
    ];
  }

  public handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  public invalidate(): void {
    this.#list.invalidate();
  }
}

class UpdateNotice implements Component {
  public constructor(
    readonly currentVersion: string,
    readonly latestVersion: string,
    readonly onClose: () => void,
  ) {}

  public render(width: number): string[] {
    void width;
    return [
      ansi.bold(ansi.green('New version available')),
      '',
      `${ansi.dim(`v${this.currentVersion}`)}  →  ${ansi.cyan(
        `v${this.latestVersion}`,
      )}`,
      '',
      `Run ${ansi.cyan('/update')} to install it.`,
      ansi.dim('Enter / Esc dismiss'),
    ];
  }

  public handleInput(data: string): void {
    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.return) ||
      matchesKey(data, Key.escape)
    ) {
      this.onClose();
    }
  }

  public invalidate(): void {
    // This notice has no cached layout state to invalidate.
  }
}

const HELP_TEXT = `${ansi.bold('Commands')}
${ansi.cyan('/new')}          Create an Internet chat
${ansi.cyan('/new-local')}    Create a direct LAN chat
${ansi.cyan('/join <code>')}  Join using an invite code
${ansi.cyan('/call')}         Start an encrypted video call
${ansi.cyan('/hangup')}       End the current video call
${ansi.cyan('/update')}       Install the latest p2pchat version
${ansi.cyan('/clear')}        Clear this activity panel
${ansi.cyan('/source')}       Show the exact release source
${ansi.cyan('/license')}      Show licensing information
${ansi.cyan('/quit')}         Exit safely`;

const SOURCE_URL = `https://p2pchat-relay.sathuashrith.com/downloads/p2pchat-${APP_TAG}-source.tar.gz`;
const LICENSE_URL = SOURCE_URL;

interface LayoutHandle {
  readonly root: Container;
  showUpdateAvailable(latestVersion: string): void;
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
  const activity = new Container();
  const pendingReply = new Container();
  const pendingAttachment = new Container();
  const editor = new Editor(tui, editorTheme, {
    paddingX: 1,
    autocompleteMaxVisible: UI_COMMAND_SUGGESTIONS.length,
  });
  editor.setAutocompleteProvider(createUiAutocompleteProvider(process.cwd()));
  const removeQuitInputListener = tui.addInputListener((data) => {
    if (isQuitSubmission(editor.getText(), data)) {
      finish();
      return { consume: true };
    }
    return undefined;
  });
  let currentSession: AuthenticatedSession | null = null;
  let currentChat: ChatSession | null = null;
  let callController: CallController | null = null;
  let callStatusText: string | null = null;
  let incomingCallOverlay: OverlayHandle | null = null;
  let pendingInvite: InviteHandle | null = null;
  let disconnectedReason: string | null = null;
  let replyToMessageId: string | null = null;
  let replyPickerOverlay: OverlayHandle | null = null;
  let availableUpdateVersion: string | null = null;
  let updateNoticeDismissed = false;
  let updateNoticeOverlay: OverlayHandle | null = null;
  let updateBusy = false;
  let pendingImage: PreparedImage | null = null;
  let bracketedPasteBuffer: string | null = null;
  let clipboardBusy = false;
  let imageSendBusy = false;
  const renderedImages = new Map<string, Image>();

  header.addChild(
    new Text(
      `${ansi.bold(ansi.cyan('p2pchat'))} ${ansi.dim(`v${APP_VERSION}`)}\n${ansi.dim(
        'private • local-first • end-to-end encrypted',
      )}\n${ansi.dim(`profile ${store.profileName} • identity ${identity.fingerprint.slice(0, 24)}…`)}`,
    ),
  );

  const setActivityText = (text: string): void => {
    activity.clear();
    activity.addChild(new Text(text, 1, 0));
  };

  const showWelcome = (): void => {
    setActivityText(
      `${ansi.green('● ready')}  No peer connected\n\n` +
        `${ansi.bold('Start a conversation')}\n` +
        `Create an Internet invitation with ${ansi.cyan('/new')}, or join one with ` +
        `${ansi.cyan('/join <code>')}.\n\n${ansi.dim(
          'Messages will be kept on this device only.',
        )}`,
    );
    tui.requestRender();
  };

  const formatMessage = (
    message: StoredMessage,
    replyTarget: StoredMessage | null,
  ): string => {
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
    const lines = [`${ansi.dim(time)} ${author}${state}`];
    if (message.replyToMessageId !== null) {
      if (replyTarget === null) {
        lines.push(`    ${ansi.dim('↪ earlier message')}`);
      } else {
        const replyAuthor =
          replyTarget.senderPeerId === identity.id
            ? ansi.cyan('you')
            : ansi.green('peer');
        lines.push(
          `    ${ansi.dim('↪')} ${replyAuthor} ${ansi.dim(
            `· ${formatReplyPreview(replyTarget)}`,
          )}`,
        );
      }
    }
    if (body.length > 0) {
      lines.push(`    ${body}`);
    }
    return lines.join('\n');
  };

  const renderStoredImage = (
    message: StoredMessage,
    renderInline: boolean,
  ): void => {
    const attachment = message.image;
    if (attachment === null) {
      return;
    }
    const attachmentBlock = new Box(MESSAGE_ATTACHMENT_PADDING_X, 0);
    if (renderInline) {
      let component = renderedImages.get(attachment.id);
      if (component === undefined) {
        const bytes = store.readImageAttachment(attachment.id);
        const base64 = bytes.toString('base64');
        bytes.fill(0);
        component = new Image(
          base64,
          attachment.mimeType,
          {
            fallbackColor: ansi.dim,
          },
          {
            filename: attachment.filename,
            maxWidthCells: CHAT_IMAGE_MAX_WIDTH,
            maxHeightCells: CHAT_IMAGE_MAX_HEIGHT,
          },
        );
        renderedImages.set(attachment.id, component);
      }
      attachmentBlock.addChild(component);
    }
    attachmentBlock.addChild(
      new Text(
        ansi.dim(
          `${attachment.filename}  ·  ${formatBytes(attachment.byteLength)}`,
        ),
        0,
        0,
      ),
    );
    activity.addChild(attachmentBlock);
  };

  const renderChat = (): void => {
    if (currentSession === null || currentChat === null) {
      showWelcome();
      return;
    }

    const messages = currentChat.history(100);
    const messagesById = new Map(
      messages.map((message) => [message.id, message] as const),
    );
    for (const message of messages) {
      if (
        message.replyToMessageId !== null &&
        !messagesById.has(message.replyToMessageId)
      ) {
        const replyTarget = currentChat.message(message.replyToMessageId);
        if (replyTarget !== null) {
          messagesById.set(replyTarget.id, replyTarget);
        }
      }
    }
    const inlineImageIds = new Set(
      messages
        .flatMap((message) =>
          message.image === null ? [] : [message.image.id],
        )
        .slice(-MAX_INLINE_HISTORY_IMAGES),
    );
    for (const attachmentId of renderedImages.keys()) {
      if (!inlineImageIds.has(attachmentId)) {
        renderedImages.delete(attachmentId);
      }
    }
    const connectionLine =
      disconnectedReason === null
        ? currentSession.transport === 'relay'
          ? `${ansi.green('● authenticated')}  Internet relay • end-to-end encrypted`
          : `${ansi.green('● authenticated')}  Direct Noise-encrypted connection`
        : `${ansi.red('● disconnected')}  ${sanitizeTerminalText(
            disconnectedReason,
            160,
          )}`;
    const callLine =
      callStatusText === null
        ? ''
        : `\n${ansi.cyan('● video')}  ${sanitizeTerminalText(callStatusText, 180)}`;
    activity.clear();
    activity.addChild(
      new Text(
        `${connectionLine}${callLine}\n` +
          `${ansi.dim(`peer ${currentSession.peer.fingerprint.slice(0, 24)}…`)}\n\n` +
          `${ansi.bold('Safety number')}  ${ansi.cyan(currentSession.safetyNumber)}\n` +
          ansi.yellow('Compare it with your peer before sharing secrets.'),
        1,
        0,
      ),
    );
    if (messages.length === 0) {
      activity.addChild(new Spacer(1));
      activity.addChild(
        new Text(ansi.dim('No messages yet. Say hello.'), 1, 0),
      );
    } else {
      for (const message of messages) {
        activity.addChild(new Spacer(1));
        activity.addChild(
          new Text(
            formatMessage(
              message,
              message.replyToMessageId === null
                ? null
                : (messagesById.get(message.replyToMessageId) ?? null),
            ),
            1,
            0,
          ),
        );
        renderStoredImage(
          message,
          message.image !== null && inlineImageIds.has(message.image.id),
        );
      }
    }
    tui.requestRender();
  };

  const onChatEvent = (event: ChatEvent): void => {
    if (event.kind === 'call-signal') {
      void callController?.receive(event.frame).catch((error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : 'Video call signaling failed';
        callStatusText = message;
        renderChat();
      });
      return;
    }
    if (event.kind === 'disconnected') {
      disconnectedReason = event.reason;
    }
    renderChat();
  };

  const closeIncomingCallPrompt = (): void => {
    incomingCallOverlay?.hide();
    incomingCallOverlay = null;
    tui.setFocus(editor);
    tui.requestRender();
  };

  const onCallControllerEvent = (event: CallControllerEvent): void => {
    if (event.kind === 'incoming') {
      if (currentSession === null || callController === null) {
        return;
      }
      replyPickerOverlay?.hide();
      replyPickerOverlay = null;
      updateNoticeOverlay?.hide();
      updateNoticeOverlay = null;
      const prompt = new IncomingCallPrompt(
        `${currentSession.peer.fingerprint.slice(0, 24)}…`,
        () => {
          closeIncomingCallPrompt();
          void callController?.accept().catch((error: unknown) => {
            callStatusText =
              error instanceof Error ? error.message : 'Unable to accept call';
            renderChat();
          });
        },
        () => {
          closeIncomingCallPrompt();
          void callController?.decline().catch((error: unknown) => {
            callStatusText =
              error instanceof Error ? error.message : 'Unable to decline call';
            renderChat();
          });
        },
      );
      incomingCallOverlay = tui.showOverlay(prompt, {
        width: '58%',
        minWidth: 48,
        maxHeight: 12,
        anchor: 'center',
        margin: 2,
      });
      tui.requestRender();
      return;
    }
    callStatusText = event.message;
    if (event.state === 'ended') {
      closeIncomingCallPrompt();
    }
    renderChat();
  };

  const renderPendingReply = (): void => {
    pendingReply.clear();
    if (replyToMessageId === null || currentChat === null) {
      tui.requestRender();
      return;
    }
    const target = currentChat.message(replyToMessageId);
    if (target === null) {
      replyToMessageId = null;
      tui.requestRender();
      return;
    }
    const author =
      target.senderPeerId === identity.id
        ? ansi.cyan('you')
        : ansi.green('peer');
    pendingReply.addChild(
      new Text(
        `${ansi.green('↪ replying to')} ${author} ${ansi.dim(
          `· ${formatReplyPreview(target)}`,
        )}\n${ansi.dim('Type your reply, then press Enter. Esc cancels the reply.')}`,
        1,
        0,
      ),
    );
    tui.requestRender();
  };

  const closeUpdateNotice = (): void => {
    updateNoticeOverlay?.hide();
    updateNoticeOverlay = null;
    updateNoticeDismissed = true;
    tui.setFocus(editor);
    tui.requestRender();
  };

  const showPendingUpdateNotice = (): void => {
    if (
      availableUpdateVersion === null ||
      updateNoticeDismissed ||
      updateNoticeOverlay !== null ||
      replyPickerOverlay !== null
    ) {
      return;
    }
    updateNoticeOverlay = tui.showOverlay(
      new UpdateNotice(APP_VERSION, availableUpdateVersion, closeUpdateNotice),
      {
        width: '55%',
        minWidth: 42,
        maxHeight: 10,
        anchor: 'center',
        margin: 2,
      },
    );
    tui.requestRender();
  };

  const showUpdateAvailable = (latestVersion: string): void => {
    availableUpdateVersion = latestVersion;
    updateNoticeDismissed = false;
    showPendingUpdateNotice();
  };

  const closeReplyPicker = (): void => {
    replyPickerOverlay?.hide();
    replyPickerOverlay = null;
    tui.setFocus(editor);
    showPendingUpdateNotice();
    tui.requestRender();
  };

  const openReplyPicker = (): void => {
    if (updateNoticeOverlay !== null) {
      closeUpdateNotice();
    }
    if (currentChat === null) {
      setActivityText(
        `${ansi.yellow('No peer connected')}\nCreate or join a chat before replying.`,
      );
      tui.requestRender();
      return;
    }
    if (replyPickerOverlay !== null) {
      replyPickerOverlay.focus();
      return;
    }
    const items = createReplySelectItems(currentChat.history(50), identity.id);
    if (items.length === 0) {
      setActivityText(
        `${ansi.yellow('Nothing to reply to')}\nSend or receive a message first.`,
      );
      tui.requestRender();
      return;
    }
    const picker = new ReplyPicker(
      items,
      (messageId) => {
        replyToMessageId = messageId;
        closeReplyPicker();
        renderPendingReply();
      },
      closeReplyPicker,
    );
    replyPickerOverlay = tui.showOverlay(picker, {
      width: '70%',
      minWidth: 42,
      maxHeight: '60%',
      anchor: 'center',
      margin: 2,
    });
    tui.requestRender();
  };

  const showConnected = (session: AuthenticatedSession): void => {
    currentSession = session;
    disconnectedReason = null;
    replyToMessageId = null;
    currentChat = new ChatSession(session, store);
    callController =
      session.transport === 'relay' && relay !== null
        ? new CallController(
            currentChat,
            relay,
            `${session.peer.fingerprint.slice(0, 24)}…`,
            onCallControllerEvent,
          )
        : null;
    renderPendingReply();
    renderChat();
    void currentChat.run(onChatEvent).catch(() => undefined);
  };

  const showAction = async (action: UiAction): Promise<void> => {
    switch (action.kind) {
      case 'call':
        if (currentChat === null || callController === null) {
          setActivityText(
            `${ansi.yellow('Private relay chat required')}\nConnect using an Internet invite before starting a video call.`,
          );
          break;
        }
        if (disconnectedReason !== null) {
          setActivityText(
            `${ansi.red('Peer is offline')}\nBoth people must keep p2pchat open. Restart and create a fresh Internet invite to reconnect.`,
          );
          break;
        }
        try {
          await callController.start();
        } catch (error: unknown) {
          if (!(error instanceof RelayPeerOfflineError)) {
            throw error;
          }
          disconnectedReason = error.message;
          callStatusText = null;
          setActivityText(
            `${ansi.red('Peer is offline')}\nThe other person is no longer connected. Keep both terminals open, or restart and create a fresh Internet invite.`,
          );
        }
        break;
      case 'clear':
        if (currentChat === null) {
          showWelcome();
        } else {
          setActivityText(
            `${ansi.green('● authenticated')}  Activity cleared\n\n${ansi.dim(
              'Encrypted history remains on this device. Your next message will restore it.',
            )}`,
          );
          tui.requestRender();
        }
        return;
      case 'help':
        setActivityText(HELP_TEXT);
        break;
      case 'hangup':
        if (!callController?.hasCall) {
          setActivityText(
            `${ansi.yellow('No active video call')}\nStart one with ${ansi.cyan('/call')}.`,
          );
          break;
        }
        await callController.hangUp();
        break;
      case 'join':
        if (currentChat !== null) {
          setActivityText(
            `${ansi.yellow('Already connected')}\nRestart p2pchat to connect to a different peer.`,
          );
          break;
        }
        if (action.code === null) {
          setActivityText(
            `${ansi.yellow('Invite code required')}\nUse ${ansi.cyan(
              '/join <code>',
            )}.`,
          );
          break;
        }

        setActivityText(
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
        setActivityText(
          `${ansi.bold('GNU AGPL v3.0 only')}\n${LICENSE_URL}\n\n` +
            ansi.dim(
              'The separately deployed Cloudflare relay is MIT-licensed.',
            ),
        );
        break;
      case 'message':
        if (currentChat === null) {
          setActivityText(
            `${ansi.yellow('No peer connected')}\nCreate or join a chat before sending a message.`,
          );
          break;
        }
        await currentChat.send(action.body, replyToMessageId);
        replyToMessageId = null;
        renderPendingReply();
        renderChat();
        break;
      case 'new-chat':
        if (currentChat !== null) {
          setActivityText(
            `${ansi.yellow('Already connected')}\nRestart p2pchat to connect to a different peer.`,
          );
          break;
        }
        if (pendingInvite !== null) {
          setActivityText(
            `${ansi.yellow('An invite is already active')}\nShare the code currently displayed or restart the app to cancel it.`,
          );
          break;
        }

        setActivityText(
          `${ansi.yellow('Creating Internet invite…')}\nUploading an opaque encrypted rendezvous record.`,
        );
        tui.requestRender();
        pendingInvite = await requireRelay(relay).createInvite();
        setActivityText(
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
          setActivityText(
            `${ansi.yellow('A chat or invite is already active')}\nRestart p2pchat to start a different connection.`,
          );
          break;
        }
        pendingInvite = (await getDirectNetwork()).createInvite();
        setActivityText(
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
        setActivityText(
          `${ansi.bold(`Corresponding source for p2pchat v${APP_VERSION}`)}\n${SOURCE_URL}`,
        );
        break;
      case 'update': {
        if (updateBusy) {
          setActivityText(
            `${ansi.yellow('Update already running')}\nWait for the installer to finish.`,
          );
          break;
        }
        updateBusy = true;
        closeUpdateNotice();
        setActivityText(
          `${ansi.yellow('Checking for updates…')}\nContacting the p2pchat release service.`,
        );
        tui.requestRender();
        try {
          const status = await checkForUpdate(APP_VERSION);
          if (!status.updateAvailable) {
            availableUpdateVersion = null;
            setActivityText(
              `${ansi.green('● already up to date')}  p2pchat v${APP_VERSION}`,
            );
            break;
          }
          setActivityText(
            `${ansi.yellow(`Installing p2pchat v${status.latestVersion}…`)}\n` +
              ansi.dim('Your profile and encrypted database are not changed.'),
          );
          tui.requestRender();
          await installLatestRelease();
          availableUpdateVersion = null;
          setActivityText(
            `${ansi.green(`● p2pchat v${status.latestVersion} installed`)}\n\n` +
              `Restart p2pchat to use the new version.`,
          );
        } finally {
          updateBusy = false;
        }
        break;
      }
    }

    tui.requestRender();
  };

  const renderPendingImage = (): void => {
    pendingAttachment.clear();
    if (pendingImage !== null) {
      const attachmentBlock = new Box(1, 0);
      attachmentBlock.addChild(
        new Text(
          `${ansi.green('● image ready')}  ${pendingImage.filename} • ${formatBytes(
            pendingImage.bytes.byteLength,
          )}\n${ansi.dim(
            imageSendBusy
              ? 'Encrypting and sending image…'
              : 'Type an optional caption, then press Enter. Esc removes the image.',
          )}`,
          0,
          0,
        ),
      );
      attachmentBlock.addChild(new Spacer(1));
      attachmentBlock.addChild(
        new Image(
          pendingImage.bytes.toString('base64'),
          pendingImage.mimeType,
          { fallbackColor: ansi.dim },
          {
            filename: pendingImage.filename,
            maxWidthCells: PENDING_IMAGE_MAX_WIDTH,
            maxHeightCells: PENDING_IMAGE_MAX_HEIGHT,
          },
        ),
      );
      pendingAttachment.addChild(attachmentBlock);
    }
    tui.requestRender();
  };

  const attachImage = (image: PreparedImage): void => {
    if (pendingImage !== null) {
      throw new Error(
        'Send or remove the current image before attaching another',
      );
    }
    pendingImage = image;
    renderPendingImage();
  };

  const showInputError = (error: unknown): void => {
    const message =
      error instanceof Error ? error.message : 'Unable to attach image';
    setActivityText(
      `${ansi.red('Image not attached')}\n${sanitizeTerminalText(message, 300)}`,
    );
    tui.requestRender();
  };

  const handlePastedContent = (content: string): void => {
    const path = extractDroppedFilePath(content);
    if (path === null) {
      editor.insertTextAtCursor(content);
      return;
    }
    void loadImageFile(path)
      .then(attachImage)
      .catch((error: unknown) => {
        if (isMissingFileError(error)) {
          editor.insertTextAtCursor(content);
          tui.requestRender();
        } else {
          showInputError(error);
        }
      });
  };

  const removeImageInputListener = tui.addInputListener((data) => {
    if (bracketedPasteBuffer !== null || data.includes('\u001B[200~')) {
      if (bracketedPasteBuffer === null) {
        const start = data.indexOf('\u001B[200~');
        const before = data.slice(0, start);
        if (before.length > 0) {
          editor.handleInput(before);
        }
        bracketedPasteBuffer = data.slice(start + 6);
      } else {
        bracketedPasteBuffer += data;
      }

      if (bracketedPasteBuffer.length > 4 * 1024 * 1024) {
        bracketedPasteBuffer = null;
        showInputError(new Error('Pasted content is too large'));
        return { consume: true };
      }
      const end = bracketedPasteBuffer.indexOf('\u001B[201~');
      if (end !== -1) {
        const content = bracketedPasteBuffer.slice(0, end);
        const remaining = bracketedPasteBuffer.slice(end + 6);
        bracketedPasteBuffer = null;
        handlePastedContent(content);
        if (remaining.length > 0) {
          editor.handleInput(remaining);
        }
      }
      return { consume: true };
    }

    if (matchesKey(data, Key.ctrl('r'))) {
      openReplyPicker();
      return { consume: true };
    }

    const pasteImageKey =
      matchesKey(data, Key.ctrl('v')) ||
      (process.platform === 'win32' && matchesKey(data, Key.alt('v')));
    if (pasteImageKey) {
      if (!clipboardBusy) {
        clipboardBusy = true;
        void readClipboardContent()
          .then((content) => {
            if (content?.kind === 'image') {
              attachImage(content.image);
            } else if (content?.kind === 'text') {
              editor.insertTextAtCursor(content.text);
              tui.requestRender();
            }
          })
          .catch(showInputError)
          .finally(() => {
            clipboardBusy = false;
          });
      }
      return { consume: true };
    }

    if (
      replyPickerOverlay === null &&
      pendingImage !== null &&
      !imageSendBusy &&
      matchesKey(data, Key.escape)
    ) {
      pendingImage.bytes.fill(0);
      pendingImage = null;
      renderPendingImage();
      return { consume: true };
    }
    if (
      replyPickerOverlay === null &&
      replyToMessageId !== null &&
      matchesKey(data, Key.escape)
    ) {
      replyToMessageId = null;
      renderPendingReply();
      return { consume: true };
    }
    return undefined;
  });

  editor.onSubmit = (input) => {
    if (
      pendingImage !== null &&
      (input.trim().length === 0 || !input.trimStart().startsWith('/'))
    ) {
      if (currentChat === null) {
        setActivityText(
          `${ansi.yellow('No peer connected')}\nCreate or join a chat before sending an image.`,
        );
        tui.requestRender();
        return;
      }
      const image = pendingImage;
      const imageReplyToMessageId = replyToMessageId;
      if (input.trim().length > 0) {
        editor.addToHistory(input);
      }
      imageSendBusy = true;
      editor.disableSubmit = true;
      renderPendingImage();
      void currentChat
        .sendImage(image, input, imageReplyToMessageId)
        .then(() => {
          image.bytes.fill(0);
          if (pendingImage === image) {
            pendingImage = null;
          }
          if (replyToMessageId === imageReplyToMessageId) {
            replyToMessageId = null;
          }
          renderPendingReply();
          renderPendingImage();
          renderChat();
        })
        .catch((error: unknown) => {
          editor.setText(input);
          showInputError(error);
        })
        .finally(() => {
          imageSendBusy = false;
          editor.disableSubmit = false;
          renderPendingImage();
        });
      return;
    }

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
      setActivityText(
        `${ansi.red('Action failed')}\n${sanitizeTerminalText(message, 300)}`,
      );
      tui.requestRender();
    });
  };

  root.addChild(header);
  root.addChild(new Spacer(1));
  root.addChild(activity);
  root.addChild(new Spacer(1));
  root.addChild(pendingReply);
  root.addChild(pendingAttachment);
  root.addChild(new Text(ansi.dim('Type a message or command'), 1, 0));
  root.addChild(editor);
  root.addChild(
    new Text(
      `${ansi.dim('Enter')} submit   ${ansi.dim('Shift+Enter')} newline   ${ansi.dim(
        'Ctrl+C',
      )} quit   ${ansi.dim('Ctrl+R')} reply   ${ansi.dim(
        'Ctrl+V / drop',
      )} image   ${ansi.dim('/')} actions`,
      1,
      0,
    ),
  );

  showWelcome();
  tui.setFocus(editor);
  return {
    root,
    showUpdateAvailable,
    close: async () => {
      removeQuitInputListener();
      removeImageInputListener();
      replyPickerOverlay?.hide();
      incomingCallOverlay?.hide();
      updateNoticeOverlay?.hide();
      pendingImage?.bytes.fill(0);
      pendingInvite?.cancel();
      await callController?.close();
      await currentChat?.close();
    },
  };
}

export async function runTerminalApp(profileName = 'default'): Promise<void> {
  const directory = await resolveProfileDataDirectory(profileName);
  const passphrase = await obtainPassphrase(directory, profileName);
  const store = await LocalStore.open({
    directory,
    passphrase,
    profileName,
  });
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
    const updateCheckController = new AbortController();
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

    terminal.setTitle(`p2pchat — ${store.profileName}`);
    tui.start();
    if (process.env['P2PCHAT_DISABLE_UPDATE_CHECK'] !== '1') {
      void checkForUpdate(APP_VERSION, {
        signal: updateCheckController.signal,
      })
        .then((status) => {
          if (!finished && status.updateAvailable) {
            layoutHandle.showUpdateAvailable(status.latestVersion);
          }
        })
        .catch(() => undefined);
    }
    await completion.promise;
    updateCheckController.abort();
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

function formatBytes(byteLength: number): string {
  return byteLength < 1024
    ? `${String(byteLength)} B`
    : `${(byteLength / 1024).toFixed(byteLength < 100 * 1024 ? 1 : 0)} KiB`;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function requireRelay(relay: RelayService | null): RelayService {
  if (relay === null) {
    throw new Error(
      'Internet relay is not configured. Set P2PCHAT_RELAY_URL or use /new-local.',
    );
  }
  return relay;
}
