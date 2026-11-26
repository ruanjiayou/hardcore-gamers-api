/**
 * 好友（`SB-060`）：**Redis 只管临时申请，MongoDB 存好友关系**。
 *
 * - Redis：`friend:req:{invite_id}` HASH {from,to,created_at}（TTL 1800s）、
 *          `friend:inbox:{player_id}` SET（收发双方都记，按 HASH 的 from/to 区分方向）。
 * - MongoDB：`friends` 一条关系一行，_id 规范化，接受申请时 upsert。
 *
 * 主体是 **player_id** 不是 user_id —— players 按 (user_id, game_id) 隔离，好友也按游戏隔离。
 * redis 与 store 都由调用方注入，测试可以塞内存假对象，不需要真实 Redis / Mongo。
 */
import { randomUUID } from 'crypto';
import config from '../config';
import { MFriend } from '../models';

const P = () => config.prefix || '';

export const inboxKey = (player_id: string) => `${P()}friend:inbox:${player_id}`;
export const reqKey = (id: string) => `${P()}friend:req:${id}`;
export const REQ_TTL = 1800;

/** 规范化关系 id：字典序小的在前 → 一条关系一行、双向天然幂等 */
export const friendId = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** 只列出本服务实际用到的 Redis 命令，方便测试塞内存实现 */
export interface FriendRedis {
  sadd(key: string, ...members: string[]): Promise<any>;
  srem(key: string, ...members: string[]): Promise<any>;
  smembers(key: string): Promise<string[]>;
  hset(key: string, value: Record<string, string>): Promise<any>;
  hgetall(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<any>;
  exists(key: string): Promise<any>;
  expire(key: string, seconds: number): Promise<any>;
}

export interface FriendRequest {
  invite_id: string;
  from: string;
  to: string;
  created_at: string;
}

/** 好友关系的持久层，抽接口是为了单测不连 Mongo */
export interface FriendStore {
  list(player_id: string): Promise<string[]>;
  has(a: string, b: string): Promise<boolean>;
  add(a: string, b: string): Promise<void>;
  remove(a: string, b: string): Promise<void>;
}

export const mongoFriendStore: FriendStore = {
  async list(player_id) {
    const rows = await MFriend.find(
      { $or: [{ player_a: player_id }, { player_b: player_id }] },
      { player_a: 1, player_b: 1 },
    ).lean(true) as any[];
    return rows.map(r => (r.player_a === player_id ? r.player_b : r.player_a));
  },
  async has(a, b) {
    return !!(await MFriend.findById(friendId(a, b)).lean(true));
  },
  async add(a, b) {
    await MFriend.updateOne(
      { _id: friendId(a, b) },
      { $setOnInsert: { _id: friendId(a, b), player_a: a, player_b: b, createdAt: new Date() } },
      { upsert: true },
    );
  },
  async remove(a, b) {
    await MFriend.deleteOne({ _id: friendId(a, b) });
  },
};

export class FriendService {
  constructor(private redis: FriendRedis, private store: FriendStore = mongoFriendStore) {}

  // ===== 好友关系（MongoDB，持久态） =====

  async listFriendIds(player_id: string): Promise<string[]> {
    return this.store.list(player_id);
  }

  async isFriend(a: string, b: string): Promise<boolean> {
    return this.store.has(a, b);
  }

  /** 接受申请：写一条规范化关系（幂等） */
  async befriend(a: string, b: string): Promise<void> {
    await this.store.add(a, b);
  }

  /** 删除好友：按规范化 id 删一条，幂等 */
  async removeFriend(a: string, b: string): Promise<void> {
    await this.store.remove(a, b);
  }

  // ===== 好友申请（Redis，临时态） =====

  /** 是否已有一封 from → to 的待处理申请（扫 to 的 inbox，顺手清理过期的） */
  async hasPending(from: string, to: string): Promise<boolean> {
    const ids = (await this.redis.smembers(inboxKey(to))) || [];
    for (const id of ids) {
      const req = await this.getRequest(id);
      if (!req) {
        await this.forget(id, to);
        continue;
      }
      if (req.from === from) return true;
    }
    return false;
  }

  async createRequest(from: string, to: string): Promise<string> {
    const id = randomUUID();
    const created_at = String(Date.now());
    await this.redis.hset(reqKey(id), { from, to, created_at });
    await this.redis.expire(reqKey(id), REQ_TTL);
    // 发出和收到都记一份，查收件箱时不用扫全库
    await this.redis.sadd(inboxKey(from), id);
    await this.redis.sadd(inboxKey(to), id);
    return id;
  }

  /** 读一封申请；HASH 已过期（TTL 到）返回 null */
  async getRequest(id: string): Promise<FriendRequest | null> {
    if (!(await this.redis.exists(reqKey(id)))) return null;
    const h = await this.redis.hgetall(reqKey(id));
    if (!h?.from || !h?.to) return null;
    return { invite_id: id, from: h.from, to: h.to, created_at: h.created_at || '' };
  }

  /** 从双方 inbox 摘掉申请 id，并删 HASH */
  async forget(id: string, ...players: string[]): Promise<void> {
    for (const pid of players) await this.redis.srem(inboxKey(pid), id);
    await this.redis.del(reqKey(id));
  }

  /** 列出某人的待处理申请（收件箱里 from/to 含他的那些），过期的顺手清理 */
  async listRequests(player_id: string): Promise<{ incoming: FriendRequest[], outgoing: FriendRequest[] }> {
    const ids = (await this.redis.smembers(inboxKey(player_id))) || [];
    const incoming: FriendRequest[] = [];
    const outgoing: FriendRequest[] = [];
    for (const id of ids) {
      const req = await this.getRequest(id);
      if (!req) {
        await this.forget(id, player_id);
        continue;
      }
      if (req.to === player_id) incoming.push(req);
      else if (req.from === player_id) outgoing.push(req);
      else await this.forget(id, player_id); // 不该出现在他的收件箱里
    }
    const byTime = (a: FriendRequest, b: FriendRequest) => Number(b.created_at) - Number(a.created_at);
    return { incoming: incoming.sort(byTime), outgoing: outgoing.sort(byTime) };
  }
}
