import { randomUUID } from 'node:crypto';

import {
  assertRelayOnlySdp,
  type CallFrame,
  type CallOffer,
  type TurnCredentials,
} from './protocol.js';
import {
  LocalCallBridge,
  type BrowserCallCommand,
  type LocalCallBridgeOptions,
} from './bridge.js';

const CALL_RESPONSE_TIMEOUT_MS = 60_000;

export type CallControllerEvent =
  | Readonly<{ kind: 'incoming'; callId: string }>
  | Readonly<{
      kind: 'status';
      state: 'opening' | 'ringing' | 'connecting' | 'active' | 'ended';
      message: string;
      localUrl?: string;
    }>;

export type CallControllerListener = (event: CallControllerEvent) => void;

export interface CallSignalingChannel {
  readonly supportsVideoCalls: boolean;
  sendCallSignal(frame: CallFrame): Promise<void>;
}

export interface CallCredentialProvider {
  createTurnCredentials(callId: string): Promise<TurnCredentials>;
}

type CallState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{
      kind: 'preparing';
      callId: string;
      role: 'caller' | 'callee';
    }>
  | Readonly<{
      kind: 'incoming';
      offer: CallOffer;
      timeout: ReturnType<typeof setTimeout>;
    }>
  | Readonly<{
      kind: 'browser';
      callId: string;
      role: 'caller' | 'callee';
      bridge: LocalCallBridge;
      timeout: ReturnType<typeof setTimeout>;
    }>;

export class CallController {
  readonly #chat: CallSignalingChannel;
  readonly #relay: CallCredentialProvider;
  readonly #peerLabel: string;
  readonly #listener: CallControllerListener;
  readonly #bridgeOptions: LocalCallBridgeOptions;
  #state: CallState = { kind: 'idle' };
  #closed = false;

  public constructor(
    chat: CallSignalingChannel,
    relay: CallCredentialProvider,
    peerLabel: string,
    listener: CallControllerListener,
    bridgeOptions: LocalCallBridgeOptions = {},
  ) {
    this.#chat = chat;
    this.#relay = relay;
    this.#peerLabel = peerLabel;
    this.#listener = listener;
    this.#bridgeOptions = bridgeOptions;
  }

  public get hasIncomingCall(): boolean {
    return this.#state.kind === 'incoming';
  }

  public get hasCall(): boolean {
    return this.#state.kind !== 'idle';
  }

  public async start(): Promise<void> {
    this.#assertAvailable();
    if (this.#state.kind !== 'idle') {
      throw new Error('A video call is already in progress');
    }
    const callId = randomUUID();
    await this.#openBrowser(callId, 'caller');
  }

  public async accept(): Promise<void> {
    this.#assertOpen();
    if (this.#state.kind !== 'incoming') {
      throw new Error('There is no incoming video call to accept');
    }
    const offer = this.#state.offer;
    clearTimeout(this.#state.timeout);
    this.#state = { kind: 'idle' };
    try {
      await this.#openBrowser(offer.callId, 'callee', offer.sdp);
    } catch (error: unknown) {
      await this.#sendEnd(offer.callId, 'failed');
      throw error;
    }
  }

  public async decline(): Promise<void> {
    this.#assertOpen();
    if (this.#state.kind !== 'incoming') {
      throw new Error('There is no incoming video call to decline');
    }
    const callId = this.#state.offer.callId;
    clearTimeout(this.#state.timeout);
    this.#state = { kind: 'idle' };
    await this.#chat.sendCallSignal({
      type: 'call-decline',
      version: 1,
      callId,
      reason: 'declined',
    });
    this.#emitEnded('Video call declined');
  }

  public async hangUp(): Promise<void> {
    this.#assertOpen();
    if (this.#state.kind === 'idle') {
      throw new Error('There is no video call to end');
    }
    if (this.#state.kind === 'incoming') {
      await this.decline();
      return;
    }
    const { callId } = this.#state;
    await this.#finishBrowserState('Video call ended');
    await this.#sendEnd(callId, 'ended');
  }

  public async receive(frame: CallFrame): Promise<void> {
    if (this.#closed) {
      return;
    }
    switch (frame.type) {
      case 'call-offer':
        await this.#receiveOffer(frame);
        return;
      case 'call-answer':
        if (
          this.#state.kind !== 'browser' ||
          this.#state.role !== 'caller' ||
          this.#state.callId !== frame.callId
        ) {
          return;
        }
        assertRelayOnlySdp(frame.sdp);
        clearTimeout(this.#state.timeout);
        this.#state.bridge.send({
          kind: 'remote-description',
          description: { type: 'answer', sdp: frame.sdp },
        });
        this.#listener({
          kind: 'status',
          state: 'connecting',
          message: 'Verifying the encrypted TURN route…',
        });
        return;
      case 'call-decline':
        if (this.#callId() !== frame.callId) {
          return;
        }
        await this.#finishBrowserState(
          frame.reason === 'busy'
            ? 'Peer is already in another call'
            : frame.reason === 'timeout'
              ? 'Peer did not answer'
              : frame.reason === 'unsupported'
                ? 'Peer cannot receive video calls'
                : 'Peer declined the video call',
        );
        return;
      case 'call-end':
        if (this.#callId() !== frame.callId) {
          return;
        }
        await this.#finishBrowserState(
          frame.reason === 'failed'
            ? 'Encrypted video call failed'
            : 'Video call ended',
        );
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const callId = this.#callId();
    if (this.#state.kind === 'incoming') {
      clearTimeout(this.#state.timeout);
    }
    await this.#finishBrowserState('Video call ended');
    if (callId !== null) {
      await this.#sendEnd(callId, 'cancelled').catch(() => undefined);
    }
  }

  async #receiveOffer(offer: CallOffer): Promise<void> {
    assertRelayOnlySdp(offer.sdp);
    if (Date.now() - Date.parse(offer.createdAt) > CALL_RESPONSE_TIMEOUT_MS) {
      await this.#chat.sendCallSignal({
        type: 'call-decline',
        version: 1,
        callId: offer.callId,
        reason: 'timeout',
      });
      return;
    }
    if (this.#state.kind !== 'idle') {
      await this.#chat.sendCallSignal({
        type: 'call-decline',
        version: 1,
        callId: offer.callId,
        reason: 'busy',
      });
      return;
    }
    const timeout = setTimeout(() => {
      if (
        this.#state.kind === 'incoming' &&
        this.#state.offer.callId === offer.callId
      ) {
        this.#state = { kind: 'idle' };
        void this.#chat.sendCallSignal({
          type: 'call-decline',
          version: 1,
          callId: offer.callId,
          reason: 'timeout',
        });
        this.#emitEnded('Incoming video call timed out');
      }
    }, CALL_RESPONSE_TIMEOUT_MS);
    this.#state = { kind: 'incoming', offer, timeout };
    this.#listener({ kind: 'incoming', callId: offer.callId });
  }

  async #openBrowser(
    callId: string,
    role: 'caller' | 'callee',
    remoteOfferSdp?: string,
  ): Promise<void> {
    if (this.#state.kind !== 'idle') {
      throw new Error('A video call is already in progress');
    }
    this.#state = { kind: 'preparing', callId, role };
    this.#listener({
      kind: 'status',
      state: 'opening',
      message: 'Requesting a private TURN route…',
    });
    let credentials: TurnCredentials;
    try {
      credentials = await this.#relay.createTurnCredentials(callId);
    } catch (error: unknown) {
      if (this.#isPreparing(callId)) {
        this.#state = { kind: 'idle' };
      }
      throw error;
    }
    if (!this.#isPreparing(callId)) {
      throw new Error('Video call setup was cancelled');
    }
    const bridge = new LocalCallBridge(
      {
        callId,
        role,
        peerLabel: this.#peerLabel,
        turnCredentials: credentials,
        ...(remoteOfferSdp === undefined ? {} : { remoteOfferSdp }),
      },
      async (command) => await this.#handleBrowserCommand(callId, command),
      this.#bridgeOptions,
    );
    const timeout = setTimeout(() => {
      if (this.#state.kind === 'browser' && this.#state.callId === callId) {
        void this.#sendEnd(callId, 'cancelled');
        void this.#finishBrowserState('Video call timed out');
      }
    }, CALL_RESPONSE_TIMEOUT_MS);
    this.#state = { kind: 'browser', callId, role, bridge, timeout };
    try {
      const localUrl = await bridge.open();
      this.#listener({
        kind: 'status',
        state: 'opening',
        message: 'Call window opened; allow camera and microphone access.',
        localUrl,
      });
    } catch (error: unknown) {
      clearTimeout(timeout);
      this.#state = { kind: 'idle' };
      await bridge.close();
      throw error;
    }
  }

  async #handleBrowserCommand(
    callId: string,
    command: BrowserCallCommand,
  ): Promise<void> {
    if (this.#state.kind !== 'browser' || this.#state.callId !== callId) {
      return;
    }
    switch (command.kind) {
      case 'description':
        assertRelayOnlySdp(command.description.sdp);
        if (
          (this.#state.role === 'caller' &&
            command.description.type !== 'offer') ||
          (this.#state.role === 'callee' &&
            command.description.type !== 'answer')
        ) {
          throw new Error('Local call window sent an unexpected description');
        }
        await this.#chat.sendCallSignal(
          command.description.type === 'offer'
            ? {
                type: 'call-offer',
                version: 1,
                callId,
                createdAt: new Date().toISOString(),
                sdp: command.description.sdp,
              }
            : {
                type: 'call-answer',
                version: 1,
                callId,
                sdp: command.description.sdp,
              },
        );
        this.#listener({
          kind: 'status',
          state:
            command.description.type === 'offer' ? 'ringing' : 'connecting',
          message:
            command.description.type === 'offer'
              ? 'Encrypted video call ringing…'
              : 'Verifying the encrypted TURN route…',
        });
        return;
      case 'verified':
        clearTimeout(this.#state.timeout);
        this.#listener({
          kind: 'status',
          state: 'active',
          message: 'TURN relay verified • DTLS-SRTP end-to-end encrypted',
        });
        return;
      case 'hangup':
        await this.#finishBrowserState('Video call ended');
        await this.#sendEnd(callId, 'ended');
        return;
      case 'failure':
        await this.#finishBrowserState(`Video call failed: ${command.reason}`);
        await this.#sendEnd(callId, 'failed');
    }
  }

  async #finishBrowserState(message: string): Promise<void> {
    const state = this.#state;
    this.#state = { kind: 'idle' };
    if (state.kind === 'incoming') {
      clearTimeout(state.timeout);
    }
    if (state.kind === 'browser') {
      clearTimeout(state.timeout);
      state.bridge.send({ kind: 'ended', reason: message });
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      await state.bridge.close();
    }
    this.#emitEnded(message);
  }

  async #sendEnd(
    callId: string,
    reason: 'ended' | 'failed' | 'cancelled',
  ): Promise<void> {
    await this.#chat.sendCallSignal({
      type: 'call-end',
      version: 1,
      callId,
      reason,
    });
  }

  #callId(): string | null {
    return this.#state.kind === 'idle'
      ? null
      : this.#state.kind === 'incoming'
        ? this.#state.offer.callId
        : this.#state.callId;
  }

  #isPreparing(callId: string): boolean {
    return this.#state.kind === 'preparing' && this.#state.callId === callId;
  }

  #emitEnded(message: string): void {
    this.#listener({ kind: 'status', state: 'ended', message });
  }

  #assertAvailable(): void {
    this.#assertOpen();
    if (!this.#chat.supportsVideoCalls) {
      throw new Error(
        'This peer is using an older p2pchat version without video calls',
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Video call controller is closed');
    }
  }
}
