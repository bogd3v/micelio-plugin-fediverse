import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * A secret (the actor's private JWK, as JSON) encrypted with AES-256-GCM, as
 * stored in the plugin store.
 *
 * @remarks
 * Same scheme as Strapi's encrypted copy of API token keys (key = SHA-256 of
 * `ENCRYPTION_KEY`, 16-byte random IV, GCM tag), plus a fixed additional
 * authenticated data label so the ciphertext only opens as an actor key.
 * Binary fields are base64url. See `docs/security/keys.md`.
 */
export interface EncryptedEnvelope {
  /** Envelope format version. */
  v: 1
  alg: 'aes-256-gcm'
  iv: string
  tag: string
  /** The ciphertext. */
  data: string
}

const IV_LENGTH = 16
const TAG_LENGTH = 16
const ADDITIONAL_DATA = Buffer.from('micelio:fediverse:actor-key:v1', 'utf8')

/** Thrown when a stored actor key cannot be decrypted; the message names `ENCRYPTION_KEY`. */
export class ActorKeyDecryptionError extends Error {
  constructor(reason: string) {
    super(
      `[fediverse] cannot decrypt the actor private key: ${reason}. ` +
        'Set ENCRYPTION_KEY back to the value the key was encrypted with; the stored key is ' +
        'left unchanged, because a new key would change the actor identity (docs/security/keys.md).'
    )
    this.name = 'ActorKeyDecryptionError'
  }
}

/** Tells an encrypted envelope from anything else, such as a plain JWK. */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (value == null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.v === 1 &&
    record.alg === 'aes-256-gcm' &&
    typeof record.iv === 'string' &&
    typeof record.tag === 'string' &&
    typeof record.data === 'string'
  )
}

/** Encrypts `plaintext` under `encryptionKey` (the raw `ENCRYPTION_KEY` value) with a fresh IV. */
export function encryptText(plaintext: string, encryptionKey: string): EncryptedEnvelope {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(encryptionKey), iv, {
    authTagLength: TAG_LENGTH,
  })
  cipher.setAAD(ADDITIONAL_DATA)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  }
}

/**
 * Decrypts an envelope made by {@link encryptText}.
 *
 * @param encryptionKey - The raw `ENCRYPTION_KEY` value, or `null` when it is not configured.
 * @throws `ActorKeyDecryptionError` when the key is missing or wrong, or the envelope was altered.
 */
export function decryptText(envelope: EncryptedEnvelope, encryptionKey: string | null): string {
  if (!encryptionKey) throw new ActorKeyDecryptionError('ENCRYPTION_KEY is not set')
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(encryptionKey),
      Buffer.from(envelope.iv, 'base64url'),
      // Without it Node accepts a tag cut down to 4 bytes.
      { authTagLength: TAG_LENGTH }
    )
    decipher.setAAD(ADDITIONAL_DATA)
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // The cause (GCM tag mismatch, bad IV length) says nothing more than the reason below.
    throw new ActorKeyDecryptionError(
      'ENCRYPTION_KEY is not the key it was encrypted with, or the stored value was altered'
    )
  }
}

function deriveKey(encryptionKey: string): Buffer {
  return createHash('sha256').update(encryptionKey).digest()
}
