import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CallController,
  type CallControllerEvent,
  type CallSignalingChannel,
} from './controller.js';
import type { CallFrame, TurnCredentials } from './protocol.js';

const relaySdp = [
  'v=0',
  'a=candidate:1 1 UDP 1 203.0.113.5 50000 typ relay raddr 0.0.0.0 rport 0',
].join('\r\n');
const turnCredentials: TurnCredentials = {
  iceServers: [
    {
      urls: ['turn:turn.example.test:3478?transport=udp'],
      username: 'temporary-user',
      credential: 'temporary-credential',
    },
  ],
  expiresAt: Date.now() + 60_000,
};
const controllers: CallController[] = [];

afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map(async (controller) => await controller.close()),
  );
});

describe('video call controller', () => {
  it('carries relay-only descriptions through encrypted call signaling', async () => {
    const signals: CallFrame[] = [];
    const events: CallControllerEvent[] = [];
    const chat: CallSignalingChannel = {
      supportsVideoCalls: true,
      sendCallSignal(frame) {
        signals.push(frame);
        return Promise.resolve();
      },
    };
    const controller = new CallController(
      chat,
      { createTurnCredentials: () => Promise.resolve(turnCredentials) },
      'PEER-1234',
      (event) => events.push(event),
      {
        openUrl: () => undefined,
        browserScriptPath: fileURLToPath(
          new URL('./browser-app.ts', import.meta.url),
        ),
      },
    );
    controllers.push(controller);
    await controller.start();

    const opening = events.find(
      (event) => event.kind === 'status' && event.localUrl !== undefined,
    );
    expect(opening?.kind).toBe('status');
    if (opening?.kind !== 'status' || opening.localUrl === undefined) {
      throw new Error('Expected a local call URL');
    }
    const callUrl = new URL(opening.localUrl);
    const token = callUrl.hash.slice(1);
    callUrl.hash = '';
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const offerResponse = await fetch(new URL('/api/commands', callUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'description',
        description: { type: 'offer', sdp: relaySdp },
      }),
    });
    expect(offerResponse.status).toBe(202);
    const offer = signals.find((frame) => frame.type === 'call-offer');
    expect(offer).toMatchObject({ type: 'call-offer', sdp: relaySdp });
    if (offer?.type !== 'call-offer') {
      throw new Error('Expected an encrypted call offer');
    }

    await controller.receive({
      type: 'call-answer',
      version: 1,
      callId: offer.callId,
      sdp: relaySdp,
    });
    const eventResponse = await fetch(new URL('/api/events?after=0', callUrl), {
      headers,
    });
    await expect(eventResponse.json()).resolves.toMatchObject({
      events: [
        {
          event: {
            kind: 'remote-description',
            description: { type: 'answer', sdp: relaySdp },
          },
        },
      ],
    });

    const verifiedResponse = await fetch(new URL('/api/commands', callUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'verified' }),
    });
    expect(verifiedResponse.status).toBe(202);
    expect(events).toContainEqual({
      kind: 'status',
      state: 'active',
      message: 'TURN relay verified • DTLS-SRTP end-to-end encrypted',
    });
    await controller.hangUp();
    expect(signals.at(-1)).toMatchObject({
      type: 'call-end',
      callId: offer.callId,
      reason: 'ended',
    });
  });

  it('accepts a current incoming offer and returns an encrypted answer', async () => {
    const signals: CallFrame[] = [];
    const events: CallControllerEvent[] = [];
    const controller = new CallController(
      {
        supportsVideoCalls: true,
        sendCallSignal(frame) {
          signals.push(frame);
          return Promise.resolve();
        },
      },
      { createTurnCredentials: () => Promise.resolve(turnCredentials) },
      'PEER-5678',
      (event) => events.push(event),
      {
        openUrl: () => undefined,
        browserScriptPath: fileURLToPath(
          new URL('./browser-app.ts', import.meta.url),
        ),
      },
    );
    controllers.push(controller);
    const callId = 'ac459897-f600-4770-a2df-df6289140534';
    await controller.receive({
      type: 'call-offer',
      version: 1,
      callId,
      createdAt: new Date().toISOString(),
      sdp: relaySdp,
    });
    expect(events).toContainEqual({ kind: 'incoming', callId });

    await controller.accept();
    const opening = events.find(
      (event) => event.kind === 'status' && event.localUrl !== undefined,
    );
    if (opening?.kind !== 'status' || opening.localUrl === undefined) {
      throw new Error('Expected an incoming local call URL');
    }
    const callUrl = new URL(opening.localUrl);
    const token = callUrl.hash.slice(1);
    callUrl.hash = '';
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    const sessionResponse = await fetch(new URL('/api/session', callUrl), {
      headers,
    });
    await expect(sessionResponse.json()).resolves.toMatchObject({
      callId,
      role: 'callee',
      remoteOfferSdp: relaySdp,
    });

    const answerResponse = await fetch(new URL('/api/commands', callUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'description',
        description: { type: 'answer', sdp: relaySdp },
      }),
    });
    expect(answerResponse.status).toBe(202);
    expect(signals).toContainEqual({
      type: 'call-answer',
      version: 1,
      callId,
      sdp: relaySdp,
    });
  });

  it('declines an expired offer without opening a call', async () => {
    const signals: CallFrame[] = [];
    const controller = new CallController(
      {
        supportsVideoCalls: true,
        sendCallSignal(frame) {
          signals.push(frame);
          return Promise.resolve();
        },
      },
      { createTurnCredentials: () => Promise.resolve(turnCredentials) },
      'PEER-9012',
      () => undefined,
    );
    controllers.push(controller);
    const callId = '7b76782e-71c9-4c0f-af8d-2ed6be765e85';
    await controller.receive({
      type: 'call-offer',
      version: 1,
      callId,
      createdAt: new Date(Date.now() - 61_000).toISOString(),
      sdp: relaySdp,
    });

    expect(controller.hasCall).toBe(false);
    expect(signals).toEqual([
      {
        type: 'call-decline',
        version: 1,
        callId,
        reason: 'timeout',
      },
    ]);
  });
});
