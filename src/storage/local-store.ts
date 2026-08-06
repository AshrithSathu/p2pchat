import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { DEFAULT_PROFILE_NAME, normalizeProfileName } from '../core/profile.js';
import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  type PreparedImage,
  type SupportedImageMimeType,
} from '../image/image.js';
import {
  decryptRecord,
  deriveEncryptionKey,
  encryptRecord,
  type KdfOptions,
} from './crypto.js';

const DATABASE_NAME = 'chat.db';
const IDENTITY_CONTEXT = 'identity:private-key:v1';
const SALT_KEY = 'encryption_salt';
const PROFILE_NAME_KEY = 'profile_name';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    public_key BLOB NOT NULL,
    encrypted_private_key BLOB NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS peers (
    peer_id TEXT PRIMARY KEY,
    public_key BLOB NOT NULL UNIQUE,
    display_name_ciphertext BLOB,
    verified_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL REFERENCES peers(peer_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
    sender_peer_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    body_ciphertext BLOB NOT NULL,
    sent_at TEXT NOT NULL,
    received_at TEXT,
    delivery_state TEXT NOT NULL CHECK (
      delivery_state IN ('pending', 'sent', 'delivered', 'received')
    ),
    UNIQUE (conversation_id, sender_peer_id, sequence_number)
  );

  CREATE INDEX IF NOT EXISTS messages_conversation_sent_at
    ON messages(conversation_id, sent_at);

  CREATE TABLE IF NOT EXISTS message_attachments (
    attachment_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
    kind TEXT NOT NULL CHECK (kind = 'image'),
    metadata_ciphertext BLOB NOT NULL,
    content_ciphertext BLOB NOT NULL,
    byte_length INTEGER NOT NULL CHECK (
      byte_length > 0 AND byte_length <= ${String(MAX_IMAGE_BYTES)}
    )
  );

  CREATE TABLE IF NOT EXISTS secure_state (
    namespace TEXT NOT NULL,
    record_key TEXT NOT NULL,
    value_ciphertext BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace, record_key)
  );
`;

interface IdentityRow {
  readonly public_key: Buffer;
  readonly encrypted_private_key: Buffer;
  readonly created_at: string;
}

interface MetadataRow {
  readonly value: string;
}

interface PeerRow {
  readonly public_key: Buffer;
}

interface SequenceRow {
  readonly next_sequence: number;
}

interface MessageIdRow {
  readonly message_id: string;
}

interface SecureStateRow {
  readonly value_ciphertext: Buffer;
}

interface MessageRow {
  readonly message_id: string;
  readonly conversation_id: string;
  readonly sender_peer_id: string;
  readonly sequence_number: number;
  readonly body_ciphertext: Buffer;
  readonly sent_at: string;
  readonly received_at: string | null;
  readonly delivery_state: MessageDeliveryState;
  readonly attachment_id: string | null;
  readonly attachment_metadata_ciphertext: Buffer | null;
  readonly attachment_byte_length: number | null;
}

interface AttachmentContentRow {
  readonly content_ciphertext: Buffer;
  readonly byte_length: number;
}

export interface LocalIdentity {
  readonly id: string;
  readonly publicKey: Buffer;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface OpenStoreOptions {
  readonly directory: string;
  readonly passphrase: string;
  readonly profileName?: string;
  readonly kdfOptions?: KdfOptions;
}

export interface PeerRecord {
  readonly id: string;
  readonly publicKey: Uint8Array;
}

export type MessageDeliveryState =
  'pending' | 'sent' | 'delivered' | 'received';

export interface StoredMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly senderPeerId: string;
  readonly sequenceNumber: number;
  readonly body: string;
  readonly sentAt: string;
  readonly receivedAt: string | null;
  readonly deliveryState: MessageDeliveryState;
  readonly image: StoredImageAttachment | null;
}

export interface StoredImageAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: SupportedImageMimeType;
  readonly byteLength: number;
}

export interface OutgoingMessageInput {
  readonly conversationId: string;
  readonly messageId: string;
  readonly sequenceNumber: number;
  readonly body: string;
  readonly sentAt: string;
}

export interface IncomingMessageInput extends OutgoingMessageInput {
  readonly senderPeerId: string;
  readonly receivedAt: string;
}

export interface OutgoingImageMessageInput extends OutgoingMessageInput {
  readonly image: PreparedImage & { readonly id: string };
}

export interface IncomingImageMessageInput extends IncomingMessageInput {
  readonly image: PreparedImage & { readonly id: string };
}

export class InvalidPassphraseError extends Error {
  public constructor() {
    super('The local passphrase is incorrect.');
    this.name = 'InvalidPassphraseError';
  }
}

function identityDetails(publicKey: Buffer, createdAt: string): LocalIdentity {
  const digest = createHash('sha256').update(publicKey).digest();
  const fingerprint = digest
    .toString('hex')
    .toUpperCase()
    .match(/.{1,4}/g)
    ?.join('-');

  if (fingerprint === undefined) {
    throw new Error('Unable to format identity fingerprint');
  }

  return {
    id: digest.toString('base64url'),
    publicKey: Buffer.from(publicKey),
    fingerprint,
    createdAt,
  };
}

export class LocalStore {
  readonly #database: Database.Database;
  readonly #encryptionKey: Buffer;
  readonly #encryptedPrivateKey: Buffer;
  readonly #identity: LocalIdentity;
  readonly #profileName: string;
  #closed = false;

  private constructor(
    database: Database.Database,
    encryptionKey: Buffer,
    identity: LocalIdentity,
    encryptedPrivateKey: Buffer,
    profileName: string,
  ) {
    this.#database = database;
    this.#encryptionKey = encryptionKey;
    this.#identity = identity;
    this.#encryptedPrivateKey = encryptedPrivateKey;
    this.#profileName = profileName;
  }

  public static async exists(directory: string): Promise<boolean> {
    try {
      await stat(join(directory, DATABASE_NAME));
      return true;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return false;
      }
      throw error;
    }
  }

  public static async open(options: OpenStoreOptions): Promise<LocalStore> {
    const profileName = normalizeProfileName(
      options.profileName ?? DEFAULT_PROFILE_NAME,
    );
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await chmod(options.directory, 0o700);

    const databasePath = join(options.directory, DATABASE_NAME);
    const database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = DELETE');
    database.pragma('synchronous = FULL');
    database.pragma('secure_delete = ON');
    database.exec(SCHEMA);
    await chmod(databasePath, 0o600);

    const selectMetadata = database.prepare<[string], MetadataRow>(
      'SELECT value FROM metadata WHERE key = ?',
    );
    const insertMetadata = database.prepare<[string, string]>(
      'INSERT INTO metadata (key, value) VALUES (?, ?)',
    );

    const storedProfileName = selectMetadata.get(PROFILE_NAME_KEY)?.value;
    if (storedProfileName !== undefined && storedProfileName !== profileName) {
      database.close();
      throw new Error(
        `Profile database belongs to "${storedProfileName}", not "${profileName}".`,
      );
    }

    let saltValue = selectMetadata.get(SALT_KEY)?.value;
    if (saltValue === undefined) {
      saltValue = randomBytes(16).toString('base64url');
      insertMetadata.run(SALT_KEY, saltValue);
    }

    const encryptionKey = await deriveEncryptionKey(
      options.passphrase,
      Buffer.from(saltValue, 'base64url'),
      options.kdfOptions,
    );

    try {
      const selectIdentity = database.prepare<[], IdentityRow>(
        `SELECT public_key, encrypted_private_key, created_at
         FROM identity WHERE singleton = 1`,
      );
      let row = selectIdentity.get();

      if (row === undefined) {
        const keyPair = generateKeyPairSync('ed25519');
        const publicKey = keyPair.publicKey.export({
          format: 'der',
          type: 'spki',
        });
        const privateKey = keyPair.privateKey.export({
          format: 'der',
          type: 'pkcs8',
        });
        const encryptedPrivateKey = encryptRecord(
          privateKey,
          encryptionKey,
          IDENTITY_CONTEXT,
        );
        privateKey.fill(0);
        const createdAt = new Date().toISOString();

        database
          .prepare<[Buffer, Buffer, string]>(
            `INSERT INTO identity
              (singleton, public_key, encrypted_private_key, created_at)
             VALUES (1, ?, ?, ?)`,
          )
          .run(publicKey, encryptedPrivateKey, createdAt);

        row = {
          public_key: publicKey,
          encrypted_private_key: encryptedPrivateKey,
          created_at: createdAt,
        };
      }

      const privateKeyBytes = decryptRecord(
        row.encrypted_private_key,
        encryptionKey,
        IDENTITY_CONTEXT,
      );
      createPrivateKey({ key: privateKeyBytes, format: 'der', type: 'pkcs8' });
      privateKeyBytes.fill(0);

      if (storedProfileName === undefined) {
        insertMetadata.run(PROFILE_NAME_KEY, profileName);
      }

      return new LocalStore(
        database,
        encryptionKey,
        identityDetails(row.public_key, row.created_at),
        Buffer.from(row.encrypted_private_key),
        profileName,
      );
    } catch (error: unknown) {
      encryptionKey.fill(0);
      database.close();

      if (error instanceof Error && error.message.includes('authenticate')) {
        throw new InvalidPassphraseError();
      }

      throw error;
    }
  }

  public get identity(): LocalIdentity {
    return {
      ...this.#identity,
      publicKey: Buffer.from(this.#identity.publicKey),
    };
  }

  public get profileName(): string {
    return this.#profileName;
  }

  public sign(payload: Uint8Array): Buffer {
    this.#assertOpen();
    const privateKeyBytes = decryptRecord(
      this.#encryptedPrivateKey,
      this.#encryptionKey,
      IDENTITY_CONTEXT,
    );

    try {
      const privateKey = createPrivateKey({
        key: privateKeyBytes,
        format: 'der',
        type: 'pkcs8',
      });
      return sign(null, payload, privateKey);
    } finally {
      privateKeyBytes.fill(0);
    }
  }

  public verify(
    publicKey: Uint8Array,
    payload: Uint8Array,
    signature: Uint8Array,
  ): boolean {
    this.#assertOpen();
    const key = createPublicKey({
      key: publicKey,
      format: 'der',
      type: 'spki',
    });
    return verify(null, payload, key, signature);
  }

  public encrypt(plaintext: Uint8Array, context: string): Buffer {
    this.#assertOpen();
    return encryptRecord(plaintext, this.#encryptionKey, context);
  }

  public decrypt(envelope: Uint8Array, context: string): Buffer {
    this.#assertOpen();
    return decryptRecord(envelope, this.#encryptionKey, context);
  }

  public readSecureState(namespace: string, recordKey: string): Buffer | null {
    this.#assertOpen();
    assertSecureStateIdentifier(namespace, 'namespace');
    assertSecureStateIdentifier(recordKey, 'record key');
    const row = this.#database
      .prepare<[string, string], SecureStateRow>(
        `SELECT value_ciphertext FROM secure_state
         WHERE namespace = ? AND record_key = ?`,
      )
      .get(namespace, recordKey);
    if (row === undefined) {
      return null;
    }
    return this.decrypt(
      row.value_ciphertext,
      secureStateContext(namespace, recordKey),
    );
  }

  public writeSecureState(
    namespace: string,
    recordKey: string,
    value: Uint8Array,
  ): void {
    this.#assertOpen();
    assertSecureStateIdentifier(namespace, 'namespace');
    assertSecureStateIdentifier(recordKey, 'record key');
    if (value.byteLength > 1024 * 1024) {
      throw new Error('Secure state record exceeds the size limit');
    }
    const ciphertext = this.encrypt(
      value,
      secureStateContext(namespace, recordKey),
    );
    this.#database
      .prepare<[string, string, Buffer, string]>(
        `INSERT INTO secure_state
          (namespace, record_key, value_ciphertext, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace, record_key) DO UPDATE SET
           value_ciphertext = excluded.value_ciphertext,
           updated_at = excluded.updated_at`,
      )
      .run(namespace, recordKey, ciphertext, new Date().toISOString());
  }

  public deleteSecureState(namespace: string, recordKey: string): boolean {
    this.#assertOpen();
    assertSecureStateIdentifier(namespace, 'namespace');
    assertSecureStateIdentifier(recordKey, 'record key');
    const result = this.#database
      .prepare<[string, string]>(
        'DELETE FROM secure_state WHERE namespace = ? AND record_key = ?',
      )
      .run(namespace, recordKey);
    return result.changes === 1;
  }

  public ensureConversation(peer: PeerRecord): string {
    this.#assertOpen();
    const publicKey = Buffer.from(peer.publicKey);
    const calculatedPeerId = createHash('sha256')
      .update(publicKey)
      .digest('base64url');
    if (calculatedPeerId !== peer.id) {
      throw new Error('Peer identity does not match its public key');
    }

    const now = new Date().toISOString();
    this.#database
      .prepare<[string, Buffer, string]>(
        `INSERT INTO peers (peer_id, public_key, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(peer_id) DO NOTHING`,
      )
      .run(peer.id, publicKey, now);

    const storedPeer = this.#database
      .prepare<[string], PeerRow>(
        'SELECT public_key FROM peers WHERE peer_id = ?',
      )
      .get(peer.id);
    if (!storedPeer?.public_key.equals(publicKey)) {
      throw new Error('Stored peer identity key does not match');
    }

    const conversationId = createHash('sha256')
      .update('p2pchat-conversation-v1\0')
      .update(peer.id)
      .digest('base64url');
    this.#database
      .prepare<[string, string, string, string]>(
        `INSERT INTO conversations
          (conversation_id, peer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO NOTHING`,
      )
      .run(conversationId, peer.id, now, now);
    return conversationId;
  }

  public nextSequenceNumber(conversationId: string): number {
    this.#assertOpen();
    const row = this.#database
      .prepare<[string, string], SequenceRow>(
        `SELECT COALESCE(MAX(sequence_number) + 1, 0) AS next_sequence
         FROM messages
         WHERE conversation_id = ? AND sender_peer_id = ?`,
      )
      .get(conversationId, this.#identity.id);
    if (row === undefined) {
      throw new Error('Unable to allocate message sequence number');
    }
    return row.next_sequence;
  }

  public saveOutgoingMessage(input: OutgoingMessageInput): void {
    this.#assertOpen();
    const ciphertext = this.encrypt(
      Buffer.from(input.body, 'utf8'),
      messageContext(input.messageId),
    );
    this.#database.transaction(() => {
      this.#database
        .prepare<[string, string, string, number, Buffer, string]>(
          `INSERT INTO messages
            (message_id, conversation_id, sender_peer_id, sequence_number,
             body_ciphertext, sent_at, delivery_state)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          input.messageId,
          input.conversationId,
          this.#identity.id,
          input.sequenceNumber,
          ciphertext,
          input.sentAt,
        );
      this.#touchConversation(input.conversationId, input.sentAt);
    })();
  }

  public saveIncomingMessage(input: IncomingMessageInput): boolean {
    this.#assertOpen();
    const ciphertext = this.encrypt(
      Buffer.from(input.body, 'utf8'),
      messageContext(input.messageId),
    );
    return this.#database.transaction(() => {
      const result = this.#database
        .prepare<[string, string, string, number, Buffer, string, string]>(
          `INSERT OR IGNORE INTO messages
            (message_id, conversation_id, sender_peer_id, sequence_number,
             body_ciphertext, sent_at, received_at, delivery_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'received')`,
        )
        .run(
          input.messageId,
          input.conversationId,
          input.senderPeerId,
          input.sequenceNumber,
          ciphertext,
          input.sentAt,
          input.receivedAt,
        );
      if (result.changes === 1) {
        this.#touchConversation(input.conversationId, input.receivedAt);
        return true;
      }

      const existing = this.#database
        .prepare<[string, string, number], MessageIdRow>(
          `SELECT message_id FROM messages
           WHERE conversation_id = ? AND sender_peer_id = ?
             AND sequence_number = ?`,
        )
        .get(input.conversationId, input.senderPeerId, input.sequenceNumber);
      if (existing?.message_id !== input.messageId) {
        throw new Error('Peer reused a message sequence number');
      }
      return false;
    })();
  }

  public saveOutgoingImageMessage(input: OutgoingImageMessageInput): void {
    this.#assertOpen();
    const bodyCiphertext = this.encrypt(
      Buffer.from(input.body, 'utf8'),
      messageContext(input.messageId),
    );
    const attachment = encryptImageAttachment(this, input.image);

    this.#database.transaction(() => {
      this.#database
        .prepare<[string, string, string, number, Buffer, string]>(
          `INSERT INTO messages
            (message_id, conversation_id, sender_peer_id, sequence_number,
             body_ciphertext, sent_at, delivery_state)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          input.messageId,
          input.conversationId,
          this.#identity.id,
          input.sequenceNumber,
          bodyCiphertext,
          input.sentAt,
        );
      this.#insertImageAttachment(input.messageId, input.image, attachment);
      this.#touchConversation(input.conversationId, input.sentAt);
    })();
  }

  public saveIncomingImageMessage(input: IncomingImageMessageInput): boolean {
    this.#assertOpen();
    const bodyCiphertext = this.encrypt(
      Buffer.from(input.body, 'utf8'),
      messageContext(input.messageId),
    );
    const attachment = encryptImageAttachment(this, input.image);

    return this.#database.transaction(() => {
      const result = this.#database
        .prepare<[string, string, string, number, Buffer, string, string]>(
          `INSERT OR IGNORE INTO messages
            (message_id, conversation_id, sender_peer_id, sequence_number,
             body_ciphertext, sent_at, received_at, delivery_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'received')`,
        )
        .run(
          input.messageId,
          input.conversationId,
          input.senderPeerId,
          input.sequenceNumber,
          bodyCiphertext,
          input.sentAt,
          input.receivedAt,
        );
      if (result.changes === 1) {
        this.#insertImageAttachment(input.messageId, input.image, attachment);
        this.#touchConversation(input.conversationId, input.receivedAt);
        return true;
      }

      const existing = this.#database
        .prepare<[string, string, number], MessageIdRow>(
          `SELECT message_id FROM messages
           WHERE conversation_id = ? AND sender_peer_id = ?
             AND sequence_number = ?`,
        )
        .get(input.conversationId, input.senderPeerId, input.sequenceNumber);
      if (existing?.message_id !== input.messageId) {
        throw new Error('Peer reused a message sequence number');
      }
      return false;
    })();
  }

  public markMessageSent(messageId: string): void {
    this.#assertOpen();
    this.#database
      .prepare<[string, string]>(
        `UPDATE messages SET delivery_state = 'sent'
         WHERE message_id = ? AND sender_peer_id = ?
           AND delivery_state = 'pending'`,
      )
      .run(messageId, this.#identity.id);
  }

  public markMessageDelivered(messageId: string, receivedAt: string): boolean {
    this.#assertOpen();
    const result = this.#database
      .prepare<[string, string, string]>(
        `UPDATE messages
         SET delivery_state = 'delivered', received_at = ?
         WHERE message_id = ? AND sender_peer_id = ?
           AND delivery_state IN ('pending', 'sent')`,
      )
      .run(receivedAt, messageId, this.#identity.id);
    return result.changes === 1;
  }

  public listMessages(
    conversationId: string,
    limit = 100,
  ): readonly StoredMessage[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Message history limit must be between 1 and 1000');
    }

    const rows = this.#database
      .prepare<[string, number], MessageRow>(
        `SELECT message_id, conversation_id, sender_peer_id, sequence_number,
                body_ciphertext, sent_at, received_at, delivery_state,
                attachment_id, attachment_metadata_ciphertext,
                attachment_byte_length
         FROM (
           SELECT messages.message_id, messages.conversation_id,
                  messages.sender_peer_id, messages.sequence_number,
                  messages.body_ciphertext, messages.sent_at,
                  messages.received_at, messages.delivery_state,
                  message_attachments.attachment_id,
                  message_attachments.metadata_ciphertext
                    AS attachment_metadata_ciphertext,
                  message_attachments.byte_length AS attachment_byte_length
           FROM messages
           LEFT JOIN message_attachments
             ON message_attachments.message_id = messages.message_id
           WHERE messages.conversation_id = ?
           ORDER BY messages.sent_at DESC, messages.message_id DESC
           LIMIT ?
         )
         ORDER BY sent_at ASC, message_id ASC`,
      )
      .all(conversationId, limit);

    return rows.map((row) => ({
      id: row.message_id,
      conversationId: row.conversation_id,
      senderPeerId: row.sender_peer_id,
      sequenceNumber: row.sequence_number,
      body: this.decrypt(
        row.body_ciphertext,
        messageContext(row.message_id),
      ).toString('utf8'),
      sentAt: row.sent_at,
      receivedAt: row.received_at,
      deliveryState: row.delivery_state,
      image: decodeStoredImageAttachment(this, row),
    }));
  }

  public readImageAttachment(attachmentId: string): Buffer {
    this.#assertOpen();
    const row = this.#database
      .prepare<[string], AttachmentContentRow>(
        `SELECT content_ciphertext, byte_length
         FROM message_attachments WHERE attachment_id = ?`,
      )
      .get(attachmentId);
    if (row === undefined) {
      throw new Error('Image attachment was not found');
    }

    const bytes = this.decrypt(
      row.content_ciphertext,
      attachmentContentContext(attachmentId),
    );
    if (bytes.byteLength !== row.byte_length) {
      bytes.fill(0);
      throw new Error('Encrypted image attachment has an invalid length');
    }
    return bytes;
  }

  public close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#database.close();
    this.#encryptionKey.fill(0);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('Local store is closed');
    }
  }

  #touchConversation(conversationId: string, updatedAt: string): void {
    this.#database
      .prepare<[string, string]>(
        'UPDATE conversations SET updated_at = ? WHERE conversation_id = ?',
      )
      .run(updatedAt, conversationId);
  }

  #insertImageAttachment(
    messageId: string,
    image: PreparedImage & { readonly id: string },
    attachment: EncryptedImageAttachment,
  ): void {
    this.#database
      .prepare<[string, string, Buffer, Buffer, number]>(
        `INSERT INTO message_attachments
          (attachment_id, message_id, kind, metadata_ciphertext,
           content_ciphertext, byte_length)
         VALUES (?, ?, 'image', ?, ?, ?)`,
      )
      .run(
        image.id,
        messageId,
        attachment.metadata,
        attachment.content,
        image.bytes.byteLength,
      );
  }
}

function messageContext(messageId: string): string {
  return `message:${messageId}:body:v1`;
}

interface ImageAttachmentMetadata {
  readonly version: 1;
  readonly filename: string;
  readonly mimeType: SupportedImageMimeType;
  readonly sha256: string;
}

interface EncryptedImageAttachment {
  readonly metadata: Buffer;
  readonly content: Buffer;
}

function encryptImageAttachment(
  store: LocalStore,
  image: PreparedImage & { readonly id: string },
): EncryptedImageAttachment {
  const metadata: ImageAttachmentMetadata = {
    version: 1,
    filename: image.filename,
    mimeType: image.mimeType,
    sha256: image.sha256,
  };
  return {
    metadata: store.encrypt(
      Buffer.from(JSON.stringify(metadata), 'utf8'),
      attachmentMetadataContext(image.id),
    ),
    content: store.encrypt(image.bytes, attachmentContentContext(image.id)),
  };
}

function decodeStoredImageAttachment(
  store: LocalStore,
  row: MessageRow,
): StoredImageAttachment | null {
  if (
    row.attachment_id === null ||
    row.attachment_metadata_ciphertext === null ||
    row.attachment_byte_length === null
  ) {
    return null;
  }
  const plaintext = store.decrypt(
    row.attachment_metadata_ciphertext,
    attachmentMetadataContext(row.attachment_id),
  );
  try {
    const value = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!isImageAttachmentMetadata(value)) {
      throw new Error('Encrypted image metadata is invalid');
    }
    return {
      id: row.attachment_id,
      filename: value.filename,
      mimeType: value.mimeType,
      byteLength: row.attachment_byte_length,
    };
  } finally {
    plaintext.fill(0);
  }
}

function isImageAttachmentMetadata(
  value: unknown,
): value is ImageAttachmentMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    typeof record['filename'] === 'string' &&
    record['filename'].length > 0 &&
    record['filename'].length <= 160 &&
    typeof record['mimeType'] === 'string' &&
    SUPPORTED_IMAGE_MIME_TYPES.some(
      (mimeType) => mimeType === record['mimeType'],
    ) &&
    typeof record['sha256'] === 'string' &&
    /^[A-Za-z0-9_-]{43}$/u.test(record['sha256'])
  );
}

function attachmentMetadataContext(attachmentId: string): string {
  return `attachment:${attachmentId}:metadata:v1`;
}

function attachmentContentContext(attachmentId: string): string {
  return `attachment:${attachmentId}:content:v1`;
}

function secureStateContext(namespace: string, recordKey: string): string {
  return `secure-state:${namespace}:${recordKey}:v1`;
}

function assertSecureStateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:@/-]{1,512}$/u.test(value)) {
    throw new Error(`Secure state ${label} is invalid`);
  }
}
