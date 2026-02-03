import {
  EnvelopeEncryptionService,
  getEncryptionService,
  resetEncryptionService,
} from '../encryption';

describe('EnvelopeEncryptionService', () => {
  const TEST_KEY = 'test-encryption-key-at-least-16-chars';

  describe('constructor', () => {
    it('should create service with valid key', () => {
      expect(() => new EnvelopeEncryptionService(TEST_KEY)).not.toThrow();
    });

    it('should throw for key shorter than 16 characters', () => {
      expect(() => new EnvelopeEncryptionService('short')).toThrow(
        'ENCRYPTION_KEY must be at least 16 characters'
      );
    });

    it('should throw for empty key', () => {
      expect(() => new EnvelopeEncryptionService('')).toThrow(
        'ENCRYPTION_KEY must be at least 16 characters'
      );
    });
  });

  describe('encrypt/decrypt', () => {
    let service: EnvelopeEncryptionService;

    beforeEach(() => {
      service = new EnvelopeEncryptionService(TEST_KEY);
    });

    it('should encrypt and decrypt a password', () => {
      const password = 'my-secret-password';
      const encrypted = service.encrypt(password);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(password);
    });

    it('should encrypt and decrypt empty string', () => {
      const password = '';
      const encrypted = service.encrypt(password);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(password);
    });

    it('should encrypt and decrypt unicode characters', () => {
      const password = 'пароль-密码-🔐';
      const encrypted = service.encrypt(password);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(password);
    });

    it('should encrypt and decrypt long passwords', () => {
      const password = 'a'.repeat(10000);
      const encrypted = service.encrypt(password);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(password);
    });

    it('should produce different ciphertext for same plaintext', () => {
      const password = 'same-password';
      const encrypted1 = service.encrypt(password);
      const encrypted2 = service.encrypt(password);

      // Each encryption should produce unique DEK and IV
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to the same value
      expect(service.decrypt(encrypted1)).toBe(password);
      expect(service.decrypt(encrypted2)).toBe(password);
    });

    it('should produce valid JSON envelope', () => {
      const encrypted = service.encrypt('test');
      const envelope = JSON.parse(encrypted);

      expect(envelope).toHaveProperty('v', 1);
      expect(envelope).toHaveProperty('dek');
      expect(envelope).toHaveProperty('data');
      expect(typeof envelope.dek).toBe('string');
      expect(typeof envelope.data).toBe('string');
    });

    it('should fail to decrypt with wrong key', () => {
      const encrypted = service.encrypt('secret');
      const otherService = new EnvelopeEncryptionService('different-key-at-least-16-chars');

      expect(() => otherService.decrypt(encrypted)).toThrow();
    });

    it('should fail to decrypt tampered ciphertext', () => {
      const encrypted = service.encrypt('secret');
      const envelope = JSON.parse(encrypted);

      // Tamper with the encrypted data
      envelope.data = Buffer.from('tampered').toString('base64');
      const tampered = JSON.stringify(envelope);

      expect(() => service.decrypt(tampered)).toThrow();
    });

    it('should throw for unsupported version', () => {
      const envelope = JSON.stringify({ v: 99, dek: 'abc', data: 'xyz' });

      expect(() => service.decrypt(envelope)).toThrow('Unsupported encryption version: 99');
    });
  });

  describe('isEncrypted', () => {
    let service: EnvelopeEncryptionService;

    beforeEach(() => {
      service = new EnvelopeEncryptionService(TEST_KEY);
    });

    it('should return true for encrypted value', () => {
      const encrypted = service.encrypt('password');
      expect(EnvelopeEncryptionService.isEncrypted(encrypted)).toBe(true);
    });

    it('should return false for plaintext', () => {
      expect(EnvelopeEncryptionService.isEncrypted('plaintext-password')).toBe(false);
    });

    it('should return false for random JSON', () => {
      expect(EnvelopeEncryptionService.isEncrypted('{"foo": "bar"}')).toBe(false);
    });

    it('should return false for partial envelope', () => {
      expect(EnvelopeEncryptionService.isEncrypted('{"v": 1, "dek": "abc"}')).toBe(false);
    });

    it('should return false for wrong version', () => {
      expect(EnvelopeEncryptionService.isEncrypted('{"v": 2, "dek": "a", "data": "b"}')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(EnvelopeEncryptionService.isEncrypted('')).toBe(false);
    });
  });
});

describe('getEncryptionService', () => {
  const originalEnv = process.env.ENCRYPTION_KEY;

  afterEach(() => {
    resetEncryptionService();
    if (originalEnv !== undefined) {
      process.env.ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it('should return null when ENCRYPTION_KEY not set', () => {
    delete process.env.ENCRYPTION_KEY;
    resetEncryptionService();

    expect(getEncryptionService()).toBeNull();
  });

  it('should return service when ENCRYPTION_KEY is set', () => {
    process.env.ENCRYPTION_KEY = 'test-key-at-least-16-chars';
    resetEncryptionService();

    const service = getEncryptionService();
    expect(service).toBeInstanceOf(EnvelopeEncryptionService);
  });

  it('should return same instance on subsequent calls', () => {
    process.env.ENCRYPTION_KEY = 'test-key-at-least-16-chars';
    resetEncryptionService();

    const service1 = getEncryptionService();
    const service2 = getEncryptionService();

    expect(service1).toBe(service2);
  });
});
