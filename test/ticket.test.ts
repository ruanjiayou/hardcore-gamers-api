import { describe, expect, test } from 'bun:test';
import { TicketTool } from '../src/utils';

/**
 * 票据过期校验（SB-043）：ticket 是一次性凭证，原来是永久有效的，
 * 泄漏一次就永久可用。encrypt 带 ttl 时写入 exp，decrypt 时校验。
 */
describe('票据有效期', () => {
  const tool = new TicketTool('test-secret');

  test('带 ttl 的票据可正常解出原载荷', () => {
    const token = tool.encrypt(JSON.stringify({ user_id: 'u1', player_id: 'p1' }), 3600);
    const data = JSON.parse(tool.decrypt(token));
    expect(data.user_id).toBe('u1');
    expect(data.exp).toBeGreaterThan(Date.now());
  });

  test('已过期的票据被拒绝', () => {
    // 直接构造一个 exp 在过去的载荷（等价于签发 1 秒后又等了很久）
    const expired = tool.encrypt(JSON.stringify({ user_id: 'u1', exp: Date.now() - 1000 }));
    expect(() => tool.decrypt(expired)).toThrow('票据已过期');
  });

  test('不带 exp 的历史票据仍可用（向后兼容）', () => {
    const legacy = tool.encrypt(JSON.stringify({ user_id: 'u1' }));
    expect(JSON.parse(tool.decrypt(legacy)).user_id).toBe('u1');
  });

  test('被篡改的票据解不开', () => {
    const token = tool.encrypt(JSON.stringify({ user_id: 'u1' }), 60);
    const [iv, tag, body] = token.split(':');
    expect(() => tool.decrypt(`${iv}:${tag}:${body.slice(0, -2)}00`)).toThrow();
  });
});
