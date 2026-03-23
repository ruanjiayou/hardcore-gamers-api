import crypto from 'crypto';

export class TicketTool {
  private readonly algorithm = 'aes-256-gcm';
  private readonly key: Buffer;

  constructor(secret: string) {
    // AES-256 需要 32 字节的密钥
    // 使用 sha256 确保无论你输入的 secret 多长，最终都能得到 32 字节的 Key
    this.key = crypto.createHash('sha256').update(secret).digest();
  }

  /**
   * 加密逻辑
   */
  encrypt(text: string): string {
    // IV (初始化向量) 必须每次随机，建议 12 字节
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // GCM 模式生成的认证标签 (16 字节)
    const authTag = cipher.getAuthTag().toString('hex');

    // 最终存储格式: IV + AuthTag + CipherText
    // 这三部分在解密时都是必须的
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * 解密逻辑
   */
  decrypt(encryptedData: string): string {
    const [ivHex, authTagHex, cipherText] = encryptedData.split(':');

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);

    // 设置认证标签，如果标签不对（数据被篡改），这里会报错
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(cipherText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}