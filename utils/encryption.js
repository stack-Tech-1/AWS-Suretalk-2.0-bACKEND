// /utils/encryption.js
const crypto = require('crypto');

class EncryptionService {
  constructor() {
    // For production, use AWS KMS or similar
    // For development, use environment variable or generate key
    this.backupKey = process.env.BACKUP_ENCRYPTION_KEY;
    
    if (!this.backupKey && process.env.NODE_ENV === 'production') {
      throw new Error('BACKUP_ENCRYPTION_KEY is required in production');
    }
  }

  // Generate a random data key (for per-backup encryption)
  generateDataKey() {
    const dataKey = crypto.randomBytes(32); // 256-bit key
    const iv = crypto.randomBytes(16); // AES-256-CBC IV
    
    return {
      dataKey: dataKey.toString('base64'),
      iv: iv.toString('base64')
    };
  }

  // Encrypt backup data with data key
  async encryptData(plaintextBuffer, dataKey, iv) {
    try {
      const keyBuffer = Buffer.from(dataKey, 'base64');
      const ivBuffer = Buffer.from(iv, 'base64');
      
      // Use AES-256-CBC for compatibility
      const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, ivBuffer);
      
      const encrypted = Buffer.concat([
        cipher.update(plaintextBuffer),
        cipher.final()
      ]);
      
      return {
        encrypted: encrypted.toString('base64'),
        algorithm: 'AES-256-CBC',
        iv: iv
      };
    } catch (error) {
      console.error('Encryption error:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  // Decrypt backup data with data key
  async decryptData(encryptedData, dataKey, iv) {
    try {
      const keyBuffer = Buffer.from(dataKey, 'base64');
      const ivBuffer = Buffer.from(iv, 'base64');
      const encryptedBuffer = Buffer.from(encryptedData, 'base64');
      
      const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, ivBuffer);
      
      const decrypted = Buffer.concat([
        decipher.update(encryptedBuffer),
        decipher.final()
      ]);
      
      return decrypted;
    } catch (error) {
      console.error('Decryption error:', error);
      throw new Error('Failed to decrypt data');
    }
  }

  // Encrypt the data key with master key (for storage)
  encryptDataKey(dataKey) {
    if (!this.backupKey) {
      // If no master key, return the data key as-is (for development)
      return dataKey;
    }
    
    try {
      const keyBuffer = Buffer.from(this.backupKey, 'base64');
      const iv = crypto.randomBytes(16);
      
      const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
      const encrypted = Buffer.concat([
        cipher.update(Buffer.from(dataKey, 'base64')),
        cipher.final()
      ]);
      
      return {
        encrypted: encrypted.toString('base64'),
        iv: iv.toString('base64')
      };
    } catch (error) {
      console.error('Data key encryption error:', error);
      throw new Error('Failed to encrypt data key');
    }
  }

  // Decrypt the data key with master key
  decryptDataKey(encryptedDataKey, iv) {
    if (!this.backupKey) {
      // If no master key, assume it's the plain data key
      return encryptedDataKey;
    }
    
    try {
      const keyBuffer = Buffer.from(this.backupKey, 'base64');
      const ivBuffer = Buffer.from(iv, 'base64');
      const encryptedBuffer = Buffer.from(encryptedDataKey, 'base64');
      
      const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, ivBuffer);
      const decrypted = Buffer.concat([
        decipher.update(encryptedBuffer),
        decipher.final()
      ]);
      
      return decrypted.toString('base64');
    } catch (error) {
      console.error('Data key decryption error:', error);
      throw new Error('Failed to decrypt data key');
    }
  }

  // Generate a secure backup key (run once to create)
  static generateBackupKey() {
    return crypto.randomBytes(32).toString('base64');
  }
}

module.exports = new EncryptionService();