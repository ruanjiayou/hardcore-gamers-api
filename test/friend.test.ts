/** 好友（`SB-060`）：内存假 Redis + 内存假关系库，验证申请 TTL 与 Mongo 关系生命周期 */
import { describe, test, expect } from 'bun:test';
import {
  FriendService, friendId, reqKey, REQ_TTL,
  type FriendRedis, type FriendStore,
} from '../src/services/FriendService';

function fakeRedis(): FriendRedis & { data: Map<string, any>, expired: Map<string, number> } {
  const data = new Map<string, any>();
  const expired = new Map<string, number>();
  const set = (key: string) => { if (!data.has(key)) data.set(key, new Set<string>()); return data.get(key) as Set<string>; };
  return {
    data, expired,
    async sadd(k, ...m) { m.forEach(x => set(k).add(x)); return m.length; },
    async srem(k, ...m) { let n = 0; m.forEach(x => { if (set(k).delete(x)) n++; }); return n; },
    async smembers(k) { return [...set(k)]; },
    async hset(k, v) { data.set(k, { ...v }); return 1; },
    async hgetall(k) { return data.get(k) || {}; },
    async del(k) { return data.delete(k) ? 1 : 0; },
    async exists(k) {
      if (expired.has(k) && expired.get(k)! <= Date.now()) { data.delete(k); expired.delete(k); return 0; }
      return data.has(k) ? 1 : 0;
    },
    async expire(k, s) { expired.set(k, Date.now() + s * 1000); return 1; },
  };
}

function fakeStore(): FriendStore & { rows: Map<string, [string, string]> } {
  const rows = new Map<string, [string, string]>();
  return {
    rows,
    async list(pid) {
      return [...rows.values()].map(([a, b]) => (a === pid ? b : (b === pid ? a : null)))
        .filter((x): x is string => !!x);
    },
    async has(a, b) { return rows.has(friendId(a, b)); },
    async add(a, b) { rows.set(friendId(a, b), [friendId(a, b).split(':')[0], friendId(a, b).split(':')[1]]); },
    async remove(a, b) { rows.delete(friendId(a, b)); },
  };
}

describe('好友（Redis 申请 + Mongo 关系）', () => {
  test('关系 id 按字典序规范化：A→B 与 B→A 是同一条', () => {
    expect(friendId('b', 'a')).toBe(friendId('a', 'b'));
    expect(friendId('a', 'b')).toBe('a:b');
  });

  test('申请 30 分钟 TTL；接受后落一条关系、申请记录清空', async () => {
    const r = fakeRedis();
    const store = fakeStore();
    const svc = new FriendService(r, store);
    const id = await svc.createRequest('pa', 'pb');

    expect(r.expired.get(reqKey(id))! - Date.now()).toBeGreaterThan(REQ_TTL * 1000 - 2000);
    expect((await svc.listRequests('pb')).incoming.map(x => x.invite_id)).toEqual([id]);
    expect((await svc.listRequests('pa')).outgoing.map(x => x.invite_id)).toEqual([id]);
    expect(await svc.isFriend('pa', 'pb')).toBe(false); // 申请阶段还没成为好友

    await svc.befriend('pa', 'pb');
    await svc.forget(id, 'pa', 'pb');
    expect(store.rows.size).toBe(1);
    expect(await svc.isFriend('pa', 'pb')).toBe(true);
    expect(await svc.isFriend('pb', 'pa')).toBe(true);
    expect(await svc.getRequest(id)).toBeNull();
    expect((await svc.listRequests('pb')).incoming).toEqual([]);
  });

  test('过期的申请读出来自动清理，不算待处理', async () => {
    const r = fakeRedis();
    const svc = new FriendService(r, fakeStore());
    const id = await svc.createRequest('pa', 'pb');
    r.expired.set(reqKey(id), Date.now() - 1); // 模拟 TTL 到点
    expect(await svc.hasPending('pa', 'pb')).toBe(false);
    expect((await svc.listRequests('pb')).incoming).toEqual([]);
    expect(r.data.has(reqKey(id))).toBe(false);
  });

  test('删除好友只删一条规范化关系，双向都查不到，幂等', async () => {
    const r = fakeRedis();
    const store = fakeStore();
    const svc = new FriendService(r, store);
    await svc.befriend('pa', 'pb');
    await svc.removeFriend('pa', 'pb');
    await svc.removeFriend('pb', 'pa');
    expect(store.rows.size).toBe(0);
    expect(await svc.isFriend('pa', 'pb')).toBe(false);
    expect(await svc.isFriend('pb', 'pa')).toBe(false);
    expect(await svc.listFriendIds('pa')).toEqual([]);
  });

  test('同一对玩家不能重复发申请（控制器两个方向都查，命中任一即挡）', async () => {
    const r = fakeRedis();
    const svc = new FriendService(r, fakeStore());
    await svc.createRequest('pa', 'pb');
    expect(await svc.hasPending('pa', 'pb')).toBe(true);
    expect(await svc.hasPending('pb', 'pa')).toBe(false);
    expect((await svc.hasPending('pa', 'pb')) || (await svc.hasPending('pb', 'pa'))).toBe(true);
  });

  test('好友关系按玩家 ID 隔离：pa 与 pb 的好友列表互不相干', async () => {
    const store = fakeStore();
    const svc = new FriendService(fakeRedis(), store);
    await svc.befriend('pa', 'pb');
    await svc.befriend('pa', 'pc');
    expect((await svc.listFriendIds('pa')).sort()).toEqual(['pb', 'pc']);
    expect(await svc.listFriendIds('pb')).toEqual(['pa']);
    expect(await svc.listFriendIds('pc')).toEqual(['pa']);
  });
});
