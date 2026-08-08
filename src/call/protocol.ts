import { z } from 'zod';

export const VIDEO_CALL_FEATURE = 'video-call-v2';

const callIdSchema = z.uuid();
const sdpSchema = z.string().min(1).max(18_000);

export const callOfferSchema = z.object({
  type: z.literal('call-offer'),
  version: z.literal(1),
  callId: callIdSchema,
  createdAt: z.iso.datetime(),
  sdp: sdpSchema,
});

export const callAnswerSchema = z.object({
  type: z.literal('call-answer'),
  version: z.literal(1),
  callId: callIdSchema,
  sdp: sdpSchema,
});

export const callDeclineSchema = z.object({
  type: z.literal('call-decline'),
  version: z.literal(1),
  callId: callIdSchema,
  reason: z.enum(['declined', 'busy', 'unsupported', 'timeout']),
});

export const callEndSchema = z.object({
  type: z.literal('call-end'),
  version: z.literal(1),
  callId: callIdSchema,
  reason: z.enum(['ended', 'failed', 'cancelled']),
});

export const callVerifiedSchema = z.object({
  type: z.literal('call-verified'),
  version: z.literal(1),
  callId: callIdSchema,
});

export const callFrameSchema = z.discriminatedUnion('type', [
  callOfferSchema,
  callAnswerSchema,
  callDeclineSchema,
  callEndSchema,
  callVerifiedSchema,
]);

export type CallOffer = z.infer<typeof callOfferSchema>;
export type CallAnswer = z.infer<typeof callAnswerSchema>;
export type CallDecline = z.infer<typeof callDeclineSchema>;
export type CallEnd = z.infer<typeof callEndSchema>;
export type CallVerified = z.infer<typeof callVerifiedSchema>;
export type CallFrame = z.infer<typeof callFrameSchema>;

const turnUrlSchema = z
  .string()
  .max(512)
  .refine(
    (value) => value.startsWith('turn:') || value.startsWith('turns:'),
    'Only TURN relay URLs are allowed',
  );

export const turnIceServerSchema = z.object({
  urls: z.array(turnUrlSchema).min(1).max(12),
  username: z.string().min(1).max(512),
  credential: z.string().min(1).max(512),
});

export const turnCredentialsSchema = z.object({
  iceServers: z.array(turnIceServerSchema).min(1).max(4),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type TurnCredentials = z.infer<typeof turnCredentialsSchema>;

export function assertRelayOnlySdp(sdp: string): void {
  const candidateLines = sdp
    .split(/\r?\n/gu)
    .filter((line) => line.startsWith('a=candidate:'));
  if (candidateLines.length === 0) {
    throw new Error('WebRTC description contains no TURN relay candidate');
  }
  if (
    candidateLines.some((line) => !/(?:^|\s)typ\s+relay(?:\s|$)/u.test(line))
  ) {
    throw new Error('WebRTC description attempted to expose a direct address');
  }
}
