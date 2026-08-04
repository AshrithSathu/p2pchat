import { z } from 'zod';

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const roomIdSchema = base64Url.length(43);
export const relayTokenSchema = base64Url.length(43);

export const createRoomSchema = z.object({
  version: z.literal(1),
  encryptedInvite: base64Url.min(40).max(16_384),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  creatorTokenHash: base64Url.length(43),
  joinerTokenHash: base64Url.length(43),
});

export const ticketRequestSchema = z.object({
  version: z.literal(1),
  role: z.enum(['creator', 'joiner']),
});

export type RelayRole = z.infer<typeof ticketRequestSchema>['role'];
export type CreateRoomRequest = z.infer<typeof createRoomSchema>;
