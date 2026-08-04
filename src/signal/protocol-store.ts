import { createHash, randomInt } from 'node:crypto';

import {
  IdentityChange,
  IdentityKeyStore,
  KEMKeyPair,
  KEMPublicKey,
  KyberPreKeyRecord,
  KyberPreKeyStore,
  PreKeyBundle,
  PreKeyRecord,
  PreKeyStore,
  PrivateKey,
  ProtocolAddress,
  PublicKey,
  SessionRecord,
  SessionStore,
  SignedPreKeyRecord,
  SignedPreKeyStore,
} from '@signalapp/libsignal-client';
import type { Direction } from '@signalapp/libsignal-client';
import { z } from 'zod';

import type { LocalStore } from '../storage/local-store.js';

const DEVICE_ID = 1;
const MAX_REGISTRATION_ID = 16_380;
const MAX_PREKEY_ID = 0x7fff_ffff;

const LOCAL_IDENTITY_NAMESPACE = 'signal-local';
const LOCAL_IDENTITY_KEY = 'identity-v1';
const SESSION_NAMESPACE = 'signal-session';
const IDENTITY_NAMESPACE = 'signal-identity';
const PREKEY_NAMESPACE = 'signal-prekey';
const SIGNED_PREKEY_NAMESPACE = 'signal-signed-prekey';
const KYBER_PREKEY_NAMESPACE = 'signal-kyber-prekey';
const KYBER_USAGE_NAMESPACE = 'signal-kyber-usage';

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u);

const localIdentitySchema = z.object({
  version: z.literal(1),
  registrationId: z.number().int().min(1).max(MAX_REGISTRATION_ID),
  privateKey: base64Url,
});

export const signalPreKeyBundleSchema = z.object({
  version: z.literal(1),
  registrationId: z.number().int().min(1).max(MAX_REGISTRATION_ID),
  deviceId: z.literal(DEVICE_ID),
  preKeyId: z.number().int().min(1).max(MAX_PREKEY_ID),
  preKey: base64Url.min(40).max(128),
  signedPreKeyId: z.number().int().min(1).max(MAX_PREKEY_ID),
  signedPreKey: base64Url.min(40).max(128),
  signedPreKeySignature: base64Url.min(80).max(128),
  identityKey: base64Url.min(40).max(128),
  kyberPreKeyId: z.number().int().min(1).max(MAX_PREKEY_ID),
  kyberPreKey: base64Url.min(1_000).max(8_192),
  kyberPreKeySignature: base64Url.min(80).max(128),
});

const kyberUsageSchema = z.object({
  version: z.literal(1),
  baseKeyHashes: z.array(base64Url.length(43)).max(64),
});

export type SignalPreKeyBundleData = z.infer<typeof signalPreKeyBundleSchema>;

export interface GeneratedSignalPreKeyBundle {
  readonly data: SignalPreKeyBundleData;
  discard(): void;
}

export class PersistentSignalProtocolStore {
  public readonly sessions: SessionStore;
  public readonly identities: IdentityKeyStore;
  public readonly preKeys: PreKeyStore;
  public readonly signedPreKeys: SignedPreKeyStore;
  public readonly kyberPreKeys: KyberPreKeyStore;

  readonly #localStore: LocalStore;
  readonly #localIdentity: z.infer<typeof localIdentitySchema>;

  public constructor(localStore: LocalStore) {
    this.#localStore = localStore;
    this.#localIdentity = ensureLocalIdentity(localStore);
    this.sessions = new PersistentSessionStore(localStore);
    this.identities = new PersistentIdentityKeyStore(
      localStore,
      this.#localIdentity,
    );
    this.preKeys = new PersistentPreKeyStore(localStore);
    this.signedPreKeys = new PersistentSignedPreKeyStore(localStore);
    this.kyberPreKeys = new PersistentKyberPreKeyStore(localStore);
  }

  public get localAddress(): ProtocolAddress {
    return ProtocolAddress.new(this.#localStore.identity.id, DEVICE_ID);
  }

  public remoteAddress(peerId: string): ProtocolAddress {
    return ProtocolAddress.new(peerId, DEVICE_ID);
  }

  public get localIdentityPublicKey(): PublicKey {
    return PrivateKey.deserialize(
      ownedBytes(Buffer.from(this.#localIdentity.privateKey, 'base64url')),
    ).getPublicKey();
  }

  public get localRegistrationId(): number {
    return this.#localIdentity.registrationId;
  }

  public createPreKeyBundle(): GeneratedSignalPreKeyBundle {
    const identityKey = PrivateKey.deserialize(
      ownedBytes(Buffer.from(this.#localIdentity.privateKey, 'base64url')),
    );
    const preKeyId = allocateRecordId(this.#localStore, PREKEY_NAMESPACE);
    const signedPreKeyId = allocateRecordId(
      this.#localStore,
      SIGNED_PREKEY_NAMESPACE,
    );
    const kyberPreKeyId = allocateRecordId(
      this.#localStore,
      KYBER_PREKEY_NAMESPACE,
    );
    const preKey = PrivateKey.generate();
    const signedPreKey = PrivateKey.generate();
    const signedPreKeySignature = identityKey.sign(
      signedPreKey.getPublicKey().serialize(),
    );
    const kyberKeyPair = KEMKeyPair.generate();
    const kyberPreKeySignature = identityKey.sign(
      kyberKeyPair.getPublicKey().serialize(),
    );

    this.#localStore.writeSecureState(
      PREKEY_NAMESPACE,
      String(preKeyId),
      PreKeyRecord.new(preKeyId, preKey.getPublicKey(), preKey).serialize(),
    );
    this.#localStore.writeSecureState(
      SIGNED_PREKEY_NAMESPACE,
      String(signedPreKeyId),
      SignedPreKeyRecord.new(
        signedPreKeyId,
        Date.now(),
        signedPreKey.getPublicKey(),
        signedPreKey,
        signedPreKeySignature,
      ).serialize(),
    );
    this.#localStore.writeSecureState(
      KYBER_PREKEY_NAMESPACE,
      String(kyberPreKeyId),
      KyberPreKeyRecord.new(
        kyberPreKeyId,
        Date.now(),
        kyberKeyPair,
        kyberPreKeySignature,
      ).serialize(),
    );

    const data = signalPreKeyBundleSchema.parse({
      version: 1,
      registrationId: this.#localIdentity.registrationId,
      deviceId: DEVICE_ID,
      preKeyId,
      preKey: Buffer.from(preKey.getPublicKey().serialize()).toString(
        'base64url',
      ),
      signedPreKeyId,
      signedPreKey: Buffer.from(
        signedPreKey.getPublicKey().serialize(),
      ).toString('base64url'),
      signedPreKeySignature: Buffer.from(signedPreKeySignature).toString(
        'base64url',
      ),
      identityKey: Buffer.from(identityKey.getPublicKey().serialize()).toString(
        'base64url',
      ),
      kyberPreKeyId,
      kyberPreKey: Buffer.from(
        kyberKeyPair.getPublicKey().serialize(),
      ).toString('base64url'),
      kyberPreKeySignature:
        Buffer.from(kyberPreKeySignature).toString('base64url'),
    });

    let discarded = false;
    return {
      data,
      discard: () => {
        if (discarded) {
          return;
        }
        discarded = true;
        this.#localStore.deleteSecureState(PREKEY_NAMESPACE, String(preKeyId));
        this.#localStore.deleteSecureState(
          SIGNED_PREKEY_NAMESPACE,
          String(signedPreKeyId),
        );
        this.#localStore.deleteSecureState(
          KYBER_PREKEY_NAMESPACE,
          String(kyberPreKeyId),
        );
        this.#localStore.deleteSecureState(
          KYBER_USAGE_NAMESPACE,
          `${String(kyberPreKeyId)}:${String(signedPreKeyId)}`,
        );
      },
    };
  }

  public clearSession(peerId: string): void {
    this.#localStore.deleteSecureState(
      SESSION_NAMESPACE,
      addressKey(this.remoteAddress(peerId)),
    );
  }

  public getRemoteIdentity(peerId: string): PublicKey | null {
    const encoded = this.#localStore.readSecureState(
      IDENTITY_NAMESPACE,
      addressKey(this.remoteAddress(peerId)),
    );
    return encoded === null ? null : PublicKey.deserialize(ownedBytes(encoded));
  }
}

export function deserializePreKeyBundle(
  value: SignalPreKeyBundleData,
): PreKeyBundle {
  const data = signalPreKeyBundleSchema.parse(value);
  return PreKeyBundle.new(
    data.registrationId,
    data.deviceId,
    data.preKeyId,
    PublicKey.deserialize(ownedBytes(Buffer.from(data.preKey, 'base64url'))),
    data.signedPreKeyId,
    PublicKey.deserialize(
      ownedBytes(Buffer.from(data.signedPreKey, 'base64url')),
    ),
    ownedBytes(Buffer.from(data.signedPreKeySignature, 'base64url')),
    PublicKey.deserialize(
      ownedBytes(Buffer.from(data.identityKey, 'base64url')),
    ),
    data.kyberPreKeyId,
    KEMPublicKey.deserialize(
      ownedBytes(Buffer.from(data.kyberPreKey, 'base64url')),
    ),
    ownedBytes(Buffer.from(data.kyberPreKeySignature, 'base64url')),
  );
}

class PersistentSessionStore extends SessionStore {
  readonly #store: LocalStore;

  public constructor(store: LocalStore) {
    super();
    this.#store = store;
  }

  public override async saveSession(
    name: ProtocolAddress,
    record: SessionRecord,
  ): Promise<void> {
    this.#store.writeSecureState(
      SESSION_NAMESPACE,
      addressKey(name),
      record.serialize(),
    );
  }

  public override async getSession(
    name: ProtocolAddress,
  ): Promise<SessionRecord | null> {
    const encoded = this.#store.readSecureState(
      SESSION_NAMESPACE,
      addressKey(name),
    );
    return encoded === null
      ? null
      : SessionRecord.deserialize(ownedBytes(encoded));
  }

  public override async getExistingSessions(
    addresses: ProtocolAddress[],
  ): Promise<SessionRecord[]> {
    return await Promise.all(
      addresses.map(async (address) => {
        const session = await this.getSession(address);
        if (session === null) {
          throw new Error(`Signal session ${address.toString()} is missing`);
        }
        return session;
      }),
    );
  }
}

class PersistentIdentityKeyStore extends IdentityKeyStore {
  readonly #store: LocalStore;
  readonly #localIdentity: z.infer<typeof localIdentitySchema>;

  public constructor(
    store: LocalStore,
    localIdentity: z.infer<typeof localIdentitySchema>,
  ) {
    super();
    this.#store = store;
    this.#localIdentity = localIdentity;
  }

  public override async getIdentityKey(): Promise<PrivateKey> {
    return PrivateKey.deserialize(
      ownedBytes(Buffer.from(this.#localIdentity.privateKey, 'base64url')),
    );
  }

  public override async getLocalRegistrationId(): Promise<number> {
    return this.#localIdentity.registrationId;
  }

  public override async saveIdentity(
    name: ProtocolAddress,
    key: PublicKey,
  ): Promise<IdentityChange> {
    const recordKey = addressKey(name);
    const existing = this.#store.readSecureState(IDENTITY_NAMESPACE, recordKey);
    if (existing !== null) {
      const current = PublicKey.deserialize(ownedBytes(existing));
      if (!current.equals(key)) {
        return IdentityChange.ReplacedExisting;
      }
      return IdentityChange.NewOrUnchanged;
    }
    this.#store.writeSecureState(
      IDENTITY_NAMESPACE,
      recordKey,
      key.serialize(),
    );
    return IdentityChange.NewOrUnchanged;
  }

  public override async isTrustedIdentity(
    name: ProtocolAddress,
    key: PublicKey,
    direction: Direction,
  ): Promise<boolean> {
    void direction;
    const existing = this.#store.readSecureState(
      IDENTITY_NAMESPACE,
      addressKey(name),
    );
    return (
      existing === null ||
      PublicKey.deserialize(ownedBytes(existing)).equals(key)
    );
  }

  public override async getIdentity(
    name: ProtocolAddress,
  ): Promise<PublicKey | null> {
    const encoded = this.#store.readSecureState(
      IDENTITY_NAMESPACE,
      addressKey(name),
    );
    return encoded === null ? null : PublicKey.deserialize(ownedBytes(encoded));
  }
}

class PersistentPreKeyStore extends PreKeyStore {
  readonly #store: LocalStore;

  public constructor(store: LocalStore) {
    super();
    this.#store = store;
  }

  public override async savePreKey(
    id: number,
    record: PreKeyRecord,
  ): Promise<void> {
    this.#store.writeSecureState(
      PREKEY_NAMESPACE,
      String(id),
      record.serialize(),
    );
  }

  public override async getPreKey(id: number): Promise<PreKeyRecord> {
    const encoded = this.#store.readSecureState(PREKEY_NAMESPACE, String(id));
    if (encoded === null) {
      throw new Error(`Signal prekey ${String(id)} is missing`);
    }
    return PreKeyRecord.deserialize(ownedBytes(encoded));
  }

  public override async removePreKey(id: number): Promise<void> {
    this.#store.deleteSecureState(PREKEY_NAMESPACE, String(id));
  }
}

class PersistentSignedPreKeyStore extends SignedPreKeyStore {
  readonly #store: LocalStore;

  public constructor(store: LocalStore) {
    super();
    this.#store = store;
  }

  public override async saveSignedPreKey(
    id: number,
    record: SignedPreKeyRecord,
  ): Promise<void> {
    this.#store.writeSecureState(
      SIGNED_PREKEY_NAMESPACE,
      String(id),
      record.serialize(),
    );
  }

  public override async getSignedPreKey(
    id: number,
  ): Promise<SignedPreKeyRecord> {
    const encoded = this.#store.readSecureState(
      SIGNED_PREKEY_NAMESPACE,
      String(id),
    );
    if (encoded === null) {
      throw new Error(`Signal signed prekey ${String(id)} is missing`);
    }
    return SignedPreKeyRecord.deserialize(ownedBytes(encoded));
  }
}

class PersistentKyberPreKeyStore extends KyberPreKeyStore {
  readonly #store: LocalStore;

  public constructor(store: LocalStore) {
    super();
    this.#store = store;
  }

  public override async saveKyberPreKey(
    id: number,
    record: KyberPreKeyRecord,
  ): Promise<void> {
    this.#store.writeSecureState(
      KYBER_PREKEY_NAMESPACE,
      String(id),
      record.serialize(),
    );
  }

  public override async getKyberPreKey(id: number): Promise<KyberPreKeyRecord> {
    const encoded = this.#store.readSecureState(
      KYBER_PREKEY_NAMESPACE,
      String(id),
    );
    if (encoded === null) {
      throw new Error(`Signal Kyber prekey ${String(id)} is missing`);
    }
    return KyberPreKeyRecord.deserialize(ownedBytes(encoded));
  }

  public override async markKyberPreKeyUsed(
    id: number,
    signedPreKeyId: number,
    baseKey: PublicKey,
  ): Promise<void> {
    const recordKey = `${String(id)}:${String(signedPreKeyId)}`;
    const encoded = this.#store.readSecureState(
      KYBER_USAGE_NAMESPACE,
      recordKey,
    );
    const usage =
      encoded === null
        ? { version: 1 as const, baseKeyHashes: [] }
        : kyberUsageSchema.parse(JSON.parse(encoded.toString('utf8')));
    const hash = createHash('sha256')
      .update(baseKey.serialize())
      .digest('base64url');
    if (usage.baseKeyHashes.includes(hash)) {
      throw new Error('Signal Kyber prekey base key was reused');
    }
    if (usage.baseKeyHashes.length >= 64) {
      throw new Error('Signal Kyber prekey usage limit exceeded');
    }
    this.#store.writeSecureState(
      KYBER_USAGE_NAMESPACE,
      recordKey,
      Buffer.from(
        JSON.stringify({
          version: 1,
          baseKeyHashes: [...usage.baseKeyHashes, hash],
        }),
        'utf8',
      ),
    );
  }
}

function ensureLocalIdentity(
  store: LocalStore,
): z.infer<typeof localIdentitySchema> {
  const existing = store.readSecureState(
    LOCAL_IDENTITY_NAMESPACE,
    LOCAL_IDENTITY_KEY,
  );
  if (existing !== null) {
    return localIdentitySchema.parse(JSON.parse(existing.toString('utf8')));
  }
  const created = localIdentitySchema.parse({
    version: 1,
    registrationId: randomInt(1, MAX_REGISTRATION_ID + 1),
    privateKey: Buffer.from(PrivateKey.generate().serialize()).toString(
      'base64url',
    ),
  });
  store.writeSecureState(
    LOCAL_IDENTITY_NAMESPACE,
    LOCAL_IDENTITY_KEY,
    Buffer.from(JSON.stringify(created), 'utf8'),
  );
  return created;
}

function allocateRecordId(store: LocalStore, namespace: string): number {
  for (let attempts = 0; attempts < 128; attempts += 1) {
    const id = randomInt(1, MAX_PREKEY_ID + 1);
    if (store.readSecureState(namespace, String(id)) === null) {
      return id;
    }
  }
  throw new Error('Unable to allocate a Signal prekey identifier');
}

function addressKey(address: ProtocolAddress): string {
  return `${address.name()}::${String(address.deviceId())}`;
}

export function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}
