/** 排行榜缓存（`SB-062`）：内存假 Redis 验证 Top100 截断、命中/失效、脏数据兜底 */
import { describe, test, expect } from 'bun:test';
import { LeaderboardCache, BOARD_SIZE, BOARD_TTL, boardKey, type CacheRedis } from '../src/services/LeaderboardCache';

function fakeRedis() {
  const data = new Map<string, string>();
  const ttl = new Map<string, number>();
  const calls: string[] = [];
  const redis: CacheRedis = {
    async get(k) { calls.push(`get:${k}`); return data.get(k) ?? null; },
    async set(k, v, s) { calls.push(`set:${k}`); data.set(k, v); ttl.set(k, s); return 1; },
    async del(...ks) { calls.push(`del:${ks.join(',')}`); ks.forEach(k => data.delete(k)); return ks.length; },
  };
  return { redis, data, ttl, calls };
}

describe('排行榜缓存', () => {
  test('未命中返回 null；写入后命中，且只缓存 Top100', async () => {
    const { redis, data, ttl } = fakeRedis();
    const cache = new LeaderboardCache(redis);
    expect(await cache.get('g1', 'endless')).toBeNull();

    const rows = Array.from({ length: 150 }, (_, i) => ({ score: 150 - i }));
    await cache.set('g1', 'endless', rows);
    expect(JSON.parse(data.get(boardKey('g1', 'endless'))!).length).toBe(BOARD_SIZE);
    expect(ttl.get(boardKey('g1', 'endless'))).toBe(BOARD_TTL);
    expect((await cache.get('g1', 'endless'))!.length).toBe(BOARD_SIZE);
  });

  test('失效同时删分榜与总榜，且不同 game_id / board 互不干扰', async () => {
    const { redis, calls } = fakeRedis();
    const cache = new LeaderboardCache(redis);
    await cache.set('g1', 'endless', [{ score: 1 }]);
    await cache.set('g1', undefined, [{ score: 2 }]);
    await cache.set('g2', 'endless', [{ score: 3 }]);

    await cache.invalidate('g1', 'endless');
    expect(calls).toContain(`del:${boardKey('g1', 'endless')},${boardKey('g1')}`);
    expect(await cache.get('g1', 'endless')).toBeNull();
    expect(await cache.get('g1')).toBeNull();
    expect(await cache.get('g2', 'endless')).not.toBeNull();
  });

  test('脏缓存当未命中，不把坏数据吐给前端', async () => {
    const { redis, data } = fakeRedis();
    data.set(boardKey('g1'), '{not json');
    expect(await new LeaderboardCache(redis).get('g1')).toBeNull();
    data.set(boardKey('g1'), '{"score":1}');
    expect(await new LeaderboardCache(redis).get('g1')).toBeNull();
  });

  test('空榜也缓存（避免反复打 Mongo）', async () => {
    const { redis, data } = fakeRedis();
    const cache = new LeaderboardCache(redis);
    await cache.set('g1', 'team', []);
    expect(data.get(boardKey('g1', 'team'))).toBe('[]');
    expect(await cache.get('g1', 'team')).toEqual([]);
  });
});
