/**
 * 最近同玩玩家缓存（`SB-063`）：Redis 有序列表，member=player_id，score=最近同场时间戳(ms)。
 *
 * 只依赖注入的 Redis 接口（zrevrange / zadd / expire），可用内存假对象单测；
 * 缓存为空时由 controller 查 matches 回源写回。6h TTL 兜底，不做写分处主动更新。
 */
import config from '../config';

export interface RecentRedis {
  zrevrange(key: string, start: number, stop: number, withScores?: 'WITHSCORES'): Promise<string[]>;
  zadd(key: string, ...scoreMember: Array<number | string>): Promise<number>;
  expire(key: string, seconds: number): Promise<any>;
  exists(key: string): Promise<number>;
}

/** 单玩家最多缓存 50 个最近同玩者，与回源取 50 场一致 */
export const RECENT_LIMIT = 50;
/** 6h 兜底过期，避免新对局一直不反映（ponytail：不做写分处主动 ZADD） */
export const RECENT_TTL = 6 * 60 * 60;
const P = () => config.prefix || '';
export const recentKey = (game_id: string, player_id: string) => `${P()}recent:${game_id}:${player_id}`;

export class RecentPlaymatesCache {
  constructor(private redis: RecentRedis) {}

  /** 按最近同场倒序取 [{player_id, at(ms)}]；空数组 = 未命中，调用方回源 */
  async get(game_id: string, player_id: string): Promise<Array<{ player_id: string, at: number }>> {
    const flat = await this.redis.zrevrange(recentKey(game_id, player_id), 0, RECENT_LIMIT - 1, 'WITHSCORES');
    const rows: Array<{ player_id: string, at: number }> = [];
    for (let i = 0; i + 1 < flat.length; i += 2) rows.push({ player_id: flat[i], at: Number(flat[i + 1]) });
    return rows;
  }

  /** rows 为 [{ player_id, at(ms) }]；空列表不写空 key */
  async set(game_id: string, player_id: string, rows: Array<{ player_id: string, at: number }>): Promise<void> {
    if (!rows.length) return;
    const args: Array<number | string> = [];
    for (const r of rows) args.push(r.at, r.player_id);
    await this.redis.zadd(recentKey(game_id, player_id), ...args);
    await this.redis.expire(recentKey(game_id, player_id), RECENT_TTL);
  }

  /**
   * 开赛后增量维护：只对**已有缓存**的玩家 ZADD 同场其他人（score=开赛时间），
   * 不新建 key —— 没看过「最近」页的玩家不需要这份冷数据。
   * 人数 <= 1 时无事可做；调用方需自己过滤机器人。
   */
  async touchOnGameStart(game_id: string, playerIds: string[], at: number): Promise<void> {
    if (playerIds.length <= 1) return;
    const byMe = playerIds.map(me => ({
      me,
      others: playerIds.filter(id => id !== me).map(id => ({ player_id: id, at })),
    }));
    await Promise.all(byMe.map(async ({ me, others }) => {
      const key = recentKey(game_id, me);
      if (!(await this.redis.exists(key))) return; // 无缓存：不建 key，等用户首次查时回源
      await this.set(game_id, me, others); // set 会刷新 TTL
    }));
  }
}
