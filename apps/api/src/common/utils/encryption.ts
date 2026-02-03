import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEK_SALT = 'betterdb-kek-salt-v1';

/**
 * Envelope encryption format.
 * The DEK (Data Encryption Key) is encrypted with the KEK (Key Encryption Key).
 * The actual data is encrypted with the DEK.
 */
interface EnvelopeEncrypted {
  /** Version marker for forward compatibility */
  v: 1;
  /** DEK encrypted with master key (base64) */
  dek: string;
  /** Data encrypted with DEK (base64) */
  data: string;
}

/**
 * Envelope Encryption Service
 *
 * Implements envelope encryption where:
 * - Each password gets a unique randomly-generated DEK (Data Encryption Key)
 * - The DEK is encrypted with a KEK (Key Encryption Key) derived from the master key
 * - Both encrypted DEK and encrypted data are stored together
 *
 * Benefits:
 * - Key rotation only requires re-encrypting DEKs, not all passwords
 * - Each password has unique encryption, preventing pattern analysis
 * - Compromising one DEK doesn't compromise other passwords
 */
export class EnvelopeEncryptionService {
  private readonly kek: Buffer;

  constructor(masterKey: string) {
    if (!masterKey || masterKey.length < 16) {
      throw new Error('ENCRYPTION_KEY must be at least 16 characters');
    }
    // Derive KEK from master key using scrypt
    this.kek = scryptSync(masterKey, KEK_SALT, 32);
  }

  /**
   * Encrypt plaintext using envelope encryption.
   * Returns a JSON string containing the encrypted envelope.
   */
  encrypt(plaintext: string): string {
    // Generate a unique DEK for this specific piece of data
    const dek = randomBytes(32);

    // Encrypt the plaintext with the DEK
    const dataIv = randomBytes(IV_LENGTH);
    const dataCipher = createCipheriv(ALGORITHM, dek, dataIv);
    const encryptedData = Buffer.concat([
      dataIv,
      dataCipher.update(plaintext, 'utf8'),
      dataCipher.final(),
      dataCipher.getAuthTag(),
    ]);

    // Encrypt the DEK with the KEK
    const dekIv = randomBytes(IV_LENGTH);
    const dekCipher = createCipheriv(ALGORITHM, this.kek, dekIv);
    const encryptedDek = Buffer.concat([
      dekIv,
      dekCipher.update(dek),
      dekCipher.final(),
      dekCipher.getAuthTag(),
    ]);

    const envelope: EnvelopeEncrypted = {
      v: 1,
      dek: encryptedDek.toString('base64'),
      data: encryptedData.toString('base64'),
    };

    return JSON.stringify(envelope);
  }

  /**
   * Decrypt an envelope-encrypted string.
   * Returns the original plaintext.
   */
  decrypt(ciphertext: string): string {
    const envelope: EnvelopeEncrypted = JSON.parse(ciphertext);

    if (envelope.v !== 1) {
      throw new Error(`Unsupported encryption version: ${envelope.v}`);
    }

    // Decrypt the DEK first
    const dekBuffer = Buffer.from(envelope.dek, 'base64');
    const dekIv = dekBuffer.subarray(0, IV_LENGTH);
    const dekEncrypted = dekBuffer.subarray(IV_LENGTH, -AUTH_TAG_LENGTH);
    const dekAuthTag = dekBuffer.subarray(-AUTH_TAG_LENGTH);

    const dekDecipher = createDecipheriv(ALGORITHM, this.kek, dekIv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    dekDecipher.setAuthTag(dekAuthTag);
    const dek = Buffer.concat([
      dekDecipher.update(dekEncrypted),
      dekDecipher.final(),
    ]);

    // Decrypt the data with the DEK
    const dataBuffer = Buffer.from(envelope.data, 'base64');
    const dataIv = dataBuffer.subarray(0, IV_LENGTH);
    const dataEncrypted = dataBuffer.subarray(IV_LENGTH, -AUTH_TAG_LENGTH);
    const dataAuthTag = dataBuffer.subarray(-AUTH_TAG_LENGTH);

    const dataDecipher = createDecipheriv(ALGORITHM, dek, dataIv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    dataDecipher.setAuthTag(dataAuthTag);

    return (
      dataDecipher.update(dataEncrypted, undefined, 'utf8') +
      dataDecipher.final('utf8')
    );
  }

  /**
   * Check if a string appears to be envelope-encrypted.
   * Used to detect already-encrypted passwords during migration.
   */
  static isEncrypted(value: string): boolean {
    if (!value.startsWith('{')) return false;
    try {
      const parsed = JSON.parse(value);
      return parsed.v === 1 && typeof parsed.dek === 'string' && typeof parsed.data === 'string';
    } catch {
      return false;
    }
  }
}

/**
 * Singleton encryption service instance.
 * Initialized lazily when ENCRYPTION_KEY is available.
 */
let encryptionInstance: EnvelopeEncryptionService | null = null;

/**
 * Get or create the encryption service singleton.
 * Returns null if ENCRYPTION_KEY is not configured.
 */
export function getEncryptionService(): EnvelopeEncryptionService | null {
  if (encryptionInstance) {
    return encryptionInstance;
  }

  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    return null;
  }

  encryptionInstance = new EnvelopeEncryptionService(key);
  return encryptionInstance;
}

/**
 * Reset the encryption service (mainly for testing).
 */
export function resetEncryptionService(): void {
  encryptionInstance = null;
}
