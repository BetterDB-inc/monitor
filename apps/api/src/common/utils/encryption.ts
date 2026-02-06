import { EnvelopeEncryptionService } from '@betterdb/shared';

export { EnvelopeEncryptionService };

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
