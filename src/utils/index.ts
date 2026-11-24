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
   * @param ttlSec 有效期（秒）。>0 时把 `exp`（绝对毫秒时间戳）写进 payload，
   *               解密时校验过期——票据原来是永久有效的，泄漏一次就永久可用。
   */
  encrypt(text: string, ttlSec = 0): string {
    if (ttlSec > 0) {
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { value: text };
      }
      text = JSON.stringify({ ...payload, exp: Date.now() + ttlSec * 1000 });
    }
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
   * 解密逻辑：签发的票据带 `exp` 时校验过期（一次性凭证不能永久有效）
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

    try {
      const payload = JSON.parse(decrypted);
      if (payload?.exp && Date.now() > Number(payload.exp)) {
        throw new Error('票据已过期');
      }
    } catch (err: any) {
      if (err?.message === '票据已过期') throw err;
      // 非 JSON 载荷（历史明文票据）不做过期校验
    }

    return decrypted;
  }
}