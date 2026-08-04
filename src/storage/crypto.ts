import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from 'node:crypto';

const ENVELOPE_VERSION = 1;
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export interface KdfOptions {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly maxMemory: number;
}

export const productionKdfOptions: KdfOptions = {
  cost: 131_072,
  blockSize: 8,
  parallelization: 1,
  maxMemory: 256 * 1024 * 1024,
};

export async function deriveEncryptionKey(
  passphrase: string,
  salt: Uint8Array,
  options: KdfOptions = productionKdfOptions,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_LENGTH,
      {
        N: options.cost,
        r: options.blockSize,
        p: options.parallelization,
        maxmem: options.maxMemory,
      },
      (error, key) => {
        if (error !== null) {
          reject(error);
          return;
        }

        resolve(key);
      },
    );
  });
}

export function encryptRecord(
  plaintext: Uint8Array,
  key: Uint8Array,
  context: string,
): Buffer {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(Buffer.from(context, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from([ENVELOPE_VERSION]),
    nonce,
    tag,
    ciphertext,
  ]);
}

export function decryptRecord(
  envelope: Uint8Array,
  key: Uint8Array,
  context: string,
): Buffer {
  const value = Buffer.from(envelope);
  const minimumLength = 1 + NONCE_LENGTH + TAG_LENGTH;

  if (value.length < minimumLength || value[0] !== ENVELOPE_VERSION) {
    throw new Error('Unsupported or malformed encrypted record');
  }

  const nonceStart = 1;
  const tagStart = nonceStart + NONCE_LENGTH;
  const ciphertextStart = tagStart + TAG_LENGTH;
  const nonce = value.subarray(nonceStart, tagStart);
  const tag = value.subarray(tagStart, ciphertextStart);
  const ciphertext = value.subarray(ciphertextStart);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
