import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DEFAULT_KEK_SALT = 'betterdb-kek-salt-v1';

function getKekSalt(): string {
  return process.env.ENCRYPTION_KEK_SALT || DEFAULT_KEK_SALT;
}

interface EnvelopeEncrypted {
  v: 1;
  dek: string;
  data: string;
}

export class EnvelopeEncryptionService {
  private readonly kek: Buffer;

  constructor(masterKey: string) {
    if (!masterKey || masterKey.length < 16) {
      throw new Error('ENCRYPTION_KEY must be at least 16 characters');
    }
    this.kek = scryptSync(masterKey, getKekSalt(), 32);
  }

  encrypt(plaintext: string): string {
    const dek = randomBytes(32);

    const dataIv = randomBytes(IV_LENGTH);
    const dataCipher = createCipheriv(ALGORITHM, dek, dataIv);
    const encryptedData = Buffer.concat([
      dataIv,
      dataCipher.update(plaintext, 'utf8'),
      dataCipher.final(),
      dataCipher.getAuthTag(),
    ]);

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

  decrypt(ciphertext: string): string {
    const envelope: EnvelopeEncrypted = JSON.parse(ciphertext);

    if (envelope.v !== 1) {
      throw new Error(`Unsupported encryption version: ${envelope.v}`);
    }

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
