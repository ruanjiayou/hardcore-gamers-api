/** 最近同玩缓存（`SB-063`）：内存假 Redis 验证命中/回源写回/排序/TTL */
import { describe, test, expect } from 'bun:test';
import {
  RecentPlaymatesCache, RECENT_LIMIT, RECENT_TTL, recentKey,
  type RecentRedis,
} from '../src/services/RecentPlaymatesCache';

function fakeRedis(): RecentRedis & { zsets: Map<string, Map<string, number>>, exp: Map<string, number> } {
  const zsets = new Map<string, Map<string, number>>();
  const exp = new Map<string, number>();
  const zset = (key: string) => {
    if (!zsets.has(key)) zsets.set(key, new Map<string, number>());
    return zsets.get(key)!;
  };
  return {
    zsets, exp,
    async zrevrange(key, start, stop, withScores) {
      if (!zsets.has(key)) return [];
      const rows = [...zsets.get(key)!].sort((a, b) => b[1] - a[1]).slice(start, stop + 1);
      return withScores ? rows.flatMap(([member, score]) => [member, String(score)]) : rows.map(([m]) => m);
    },
    async zadd(key, ...args) {
      let n = 0;
      for (let i = 0; i + 1 < args.length; i += 2) {
        zset(key).set(String(args[i + 1]), Number(args[i]));
        n++;
      }
      return n;
    },
    async expire(key, seconds) { exp.set(key, seconds); return 1; },
    async exists(key) { return zsets.has(key) && zsets.get(key)!.size > 0 ? 1 : 0; },
  };
}

describe('最近同玩玩家缓存（Redis ZSET）', () => {
  test('空缓存未命中；写回后按最近时间戳倒序读取', async () => {
    const r = fakeRedis();
    const cache = new RecentPlaymatesCache(r);
    expect(await cache.get('g1', 'me')).toEqual([]);

    await cache.set('g1', 'me', [
      { player_id: 'a', at: 100 },
      { player_id: 'b', at: 300 },
      { player_id: 'c', at: 200 },
    ]);
    expect((await cache.get('g1', 'me')).map(x => x.player_id)).toEqual(['b', 'c', 'a']);
    expect(r.exp.get(recentKey('g1', 'me'))).toBe(RECENT_TTL);
  });

  test('按 game_id + player_id 隔离，空写入不建 key', async () => {
    const r = fakeRedis();
    const cache = new RecentPlaymatesCache(r);
    await cache.set('g1', 'me', [{ player_id: 'a', at: 1 }]);
    await cache.set('g1', 'other', []);

    expect((await cache.get('g1', 'me')).map(x => x.player_id)).toEqual(['a']);
    expect(await cache.get('g1', 'other')).toEqual([]);
    expect(await cache.get('g2', 'me')).toEqual([]);
    expect(r.zsets.size).toBe(1);
  });

  test('开赛增量维护：只更新已有缓存的玩家，不建新 key、刷新 TTL', async () => {
    const r = fakeRedis();
    const cache = new RecentPlaymatesCache(r);
    await cache.set('g1', 'me', [{ player_id: 'old', at: 100 }]);
    r.exp.set(recentKey('g1', 'me'), 1); // 模拟快过期

    await cache.touchOnGameStart('g1', ['me', 'new', 'robot'], 500);
    expect((await cache.get('g1', 'me')).map(x => x.player_id).sort()).toEqual(['new', 'old', 'robot']);
    expect(r.exp.get(recentKey('g1', 'me'))).toBe(RECENT_TTL);
    expect(r.zsets.has(recentKey('g1', 'new'))).toBe(false); // 没缓存的人不建冷 key
    expect(r.zsets.has(recentKey('g1', 'robot'))).toBe(false);
  });

  test('最多取 RECENT_LIMIT 条，避免大列表', async () => {
    const r = fakeRedis();
    const cache = new RecentPlaymatesCache(r);
    const rows = Array.from({ length: RECENT_LIMIT + 10 }, (_, i) => ({ player_id: `p${i}`, at: i }));
    await cache.set('g1', 'me', rows);
    const got = await cache.get('g1', 'me');
    expect(got.length).toBe(RECENT_LIMIT);
    expect(got[0].player_id).toBe(`p${RECENT_LIMIT + 9}`);
  });
});
