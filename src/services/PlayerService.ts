/**
 * 玩家管理服务
 * 负责玩家的创建、查询、更新等操作
 */

import { v7 } from 'uuid';
import { MGame, MMatch, MPlayer, MRoom, MUser } from '../models';
import redis from '../utils/redis'
import config from '../config';
import { isEmpty, sumBy } from 'lodash';
import constant, { PlayerState, RoomStatus } from '../constant';
import { isDanglingRoomRef, isZombieMatch, isZombieRoom } from '../utils/roomPolicy';

export class PlayerService {

  /**
   * 校正玩家的 room_id：房间已不存在 / 已软删 / 玩家已不在成员列表时清空。
   * 悬空引用会让前端"进入游戏"直接跳到不存在的房间，弹出"房间不存在"。
   * 只在读取玩家时顺手修，不做全表扫描（全表修复见 repairDanglingRooms）。
   */
  async sanitizePlayerRoom<T extends { _id: string; room_id?: string }>(player: T): Promise<T> {
    if (!player?.room_id) return player;
    const room = await MRoom.findById(player.room_id).lean(true) as any;
    if (!isDanglingRoomRef(player, room)) return player;
    await MPlayer.updateOne(
      { _id: player._id },
      { $set: { room_id: '', state: constant.PLAYER.STATE.online } },
    );
    return { ...player, room_id: '', state: constant.PLAYER.STATE.online };
  }

  /**
   * 全表修复悬空的玩家 room_id（服务启动时调用一次）。
   *
   * 判定逻辑抽在 utils/roomPolicy.isDanglingRoomRef（纯函数，可单测）。
   * 这里按房间批量查，避免逐个玩家往返查询。
   */
  async repairDanglingRooms(): Promise<number> {
    const players = await MPlayer.find({ room_id: { $nin: ['', null] } }, { _id: 1, room_id: 1 }).lean(true) as any[];
    if (!players.length) return 0;
    const roomIds = [...new Set(players.map(p => String(p.room_id)))];
    const rooms = await MRoom.find({ _id: { $in: roomIds } }).lean(true) as any[];
    const roomMap = new Map(rooms.map(r => [String(r._id), r]));

    const ids = players
      .filter(p => isDanglingRoomRef(p, roomMap.get(String(p.room_id))))
      .map(p => p._id);
    if (!ids.length) return 0;
    await MPlayer.updateMany(
      { _id: { $in: ids } },
      { $set: { room_id: '', state: constant.PLAYER.STATE.online } },
    );
    console.log(`🧹 清理悬空 room_id 的玩家: ${ids.length}`);
    return ids.length;
  }

  /**
   * 清理同一 (user_id, game_id) 的重复玩家记录（服务启动时调用一次）。
   *
   * 历史上有过"改名/改库"操作，导致同一个用户在同一个游戏下有多条 player 记录：
   * - getOrCreatePlayer 用 findOne({user_id, game_id}) 取到的是任意一条，
   *   运气好时拿到干净的那条、运气差时拿到挂着旧 room_id 的那条，
   *   表现为"进游戏就被弹回一个早就不该在的房间"；
   * - 旧的重复记录还会让排行榜出现同一人的多条数据。
   *
   * 策略：保留每组里最新的一条（updatedAt 优先，其次 createdAt），
   * 其余重复记录直接删除。删除前会把 room_id 清空，避免留下悬空指针。
   */
  async dedupePlayers(): Promise<number> {
    const groups = await MPlayer.aggregate([
      { $match: { user_id: { $nin: ['', null] } } },
      { $sort: { updatedAt: -1, createdAt: -1 } },
      {
        $group: {
          _id: { user_id: '$user_id', game_id: '$game_id' },
          keep: { $first: '$_id' },
          dupes: { $push: '$_id' },
        },
      },
      { $match: { 'dupes.1': { $exists: true } } },
    ]);
    let removed = 0;
    for (const g of groups) {
      const dupes = (g.dupes as string[]).filter(id => id !== g.keep);
      if (!dupes.length) continue;
      await MPlayer.updateMany(
        { _id: { $in: dupes } },
        { $set: { room_id: '', state: constant.PLAYER.STATE.online } },
      );
      await MPlayer.deleteMany({ _id: { $in: dupes } });
      removed += dupes.length;
      console.log(`🧹 重复玩家记录：user=${g._id.user_id} game=${g._id.game_id} 保留 ${g.keep}，删除 ${dupes.length} 条`);
    }
    if (removed) console.log(`🧹 共清理重复玩家记录 ${removed} 条`);
    return removed;
  }

  /**
   * 清理 game_id 指向已不存在游戏的孤儿玩家记录（服务启动时调用一次）。
   *
   * 库改名/改库后，旧 game_id（Mongo ObjectId 格式）会与新的 slug 格式 _id 对不上，
   * 这些记录永远不会被 getOrCreatePlayer 命中，却会一直留在库里。
   */
  async removeOrphanPlayers(): Promise<number> {
    const gameIds = new Set((await MGame.find({}, { _id: 1 }).lean(true)).map(g => String(g._id)));
    const players = await MPlayer.find({}, { _id: 1, game_id: 1 }).lean(true);
    const orphanIds = players
      .filter(p => !gameIds.has(String(p.game_id)))
      .map(p => p._id);
    if (!orphanIds.length) return 0;
    await MPlayer.deleteMany({ _id: { $in: orphanIds } });
    console.log(`🧹 清理孤儿玩家记录（game_id 不存在）: ${orphanIds.length}`);
    return orphanIds.length;
  }

  /**
   * 清理僵尸对局与僵尸房间（服务启动时调用一次）。
   *
   * - 僵尸对局：status=playing，但房间已经回到 waiting / 已解散 / 已不存在
   *   （服务端重启前没走完结算流程，或房间被强制解散）。
   *   这些对局会让房间列表一直显示"游戏中"，玩家点进去却玩不了。
   * - 僵尸房间：status=playing 但 match_id 指向的对局不存在。
   */
  async cleanupZombieMatches(): Promise<number> {
    const matches = await MMatch.find({ status: constant.MATCH.STATUS.playing }).lean(true) as any[];
    if (!matches.length) return 0;
    const matchIds = new Set(matches.map(m => String(m._id)));
    const rooms = await MRoom.find({ match_id: { $in: [...matchIds] } }).lean(true) as any[];
    const roomByMatch = new Map(rooms.map(r => [String(r.match_id), r]));

    const zombieMatchIds: string[] = [];
    for (const m of matches) {
      const room = roomByMatch.get(String(m._id));
      if (isZombieMatch(m, room)) zombieMatchIds.push(m._id);
    }
    if (zombieMatchIds.length) {
      await MMatch.updateMany(
        { _id: { $in: zombieMatchIds } },
        { $set: { status: constant.MATCH.STATUS.gameover, updatedAt: new Date() } },
      );
    }
    // 房间停在 playing 但对局已不在「进行中」集合里（不存在或已结算）
    // → 房间回等待态，避免列表里一直显示"对局中"却点不进去
    const allPlayingRooms = await MRoom.find({ status: constant.ROOM.STATUS.playing }).lean(true) as any[];
    const zombieRooms = allPlayingRooms.filter(r => isZombieRoom(r, matchIds));
    for (const r of zombieRooms) {
      await MRoom.updateOne(
        { _id: r._id },
        { $set: { status: constant.ROOM.STATUS.waiting, match_id: '', updatedAt: new Date() } },
      );
      console.log(`🧹 僵尸房间回等待态: ${r._id}（对局 ${r.match_id} 已不存在）`);
    }
    if (zombieMatchIds.length) {
      console.log(`🧹 清理僵尸对局: ${zombieMatchIds.length}`);
    }
    return zombieMatchIds.length + zombieRooms.length;
  }

  /**
   * 创建或获取玩家
   */
  async getOrCreatePlayer(user_id: string, name: string) {
    const game = await MGame.findOne({ $or: [{ _id: name }, { slug: name }] })
    if (!game) {
      throw new Error('游戏不存在')
    }
    // 如果玩家已存在，返回该玩家（顺手清掉指向已消失/已解散房间的悬空 room_id）
    // 排序取最新的一条：历史上同一 (user_id, game_id) 可能有多条记录（改库/改名留下的），
    // findOne 不排序时命中哪条是随机的 —— 命中挂着旧 room_id 的那条就会出现
    // "进游戏被弹回旧房间、反复弹已离开房间"。
    let player = await MPlayer.findOne({ user_id, game_id: game._id })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean(true);
    if (player) {
      return this.sanitizePlayerRoom(player);
    }
    const user = await MUser.findById(user_id).lean(true);
    if (!user) {
      throw new Error('用户不存在')
    }
    // 创建新玩家
    const time = new Date();
    player = await MPlayer.create({
      _id: v7(),
      game_id: game._id,
      user_id,
      nickname: user.name,
      status: 1,
      atline: true,
      type: constant.PLAYER.TYPE.player,
      state: constant.PLAYER.STATE.online,
      avatar: user.avatar,
      createdAt: time,
      updatedAt: time,
      stats: {
        games: 0,
        winnings: 0,
        win_rate: 0,
        flee_rate: 0,
      }
    });

    console.log(`✨ 新玩家创建: ${player.nickname} (${player._id}) user=${user_id} game=${game.slug || game._id}`);
    return player;
  }

  /**
   * 获取玩家信息
   */
  async getPlayerById(_id: string) {
    return MPlayer.findOne({ _id }).lean(true);
  }

  /**
   * 更新玩家状态
   */
  async updatePlayerStatus(player_id: string, state: string) {
    // status 是数字（1 normal / 2 muted / 3 banned），在线状态在 state 字段。
    // 原实现把 'in-lobby' 等字符串写进数字字段会触发 CastError，且写错字段。
    await MPlayer.updateOne({ _id: player_id }, { $set: { state } })
  }

  /**
   * TODO: 更新玩家统计
   */
  async updatePlayerStats(player_id: string, isWin: boolean, ratingChange: number = 0) {
    const player = await MPlayer.findById(player_id).lean(true)
    if (!player) return;

    const stats = player.stats;
    stats.matches++;

    if (isWin) {
      stats.winners++;
    }

    // 升级逻辑：每赢10局升1级
    const requiredWins = player.level * 10;
    if (stats.winners >= requiredWins) {
      player.level++;
      console.log(`🎉 玩家 ${player.user_id} 升级到 Lv.${player.level}`);
    }
  }

  /**
   * 获取排行榜
   * @param board 可选分榜 key（如贪吃蛇 endless/team）：按 boards.<key> 最高分排序；
   *              缺省按游戏总分 score 排序（棋类等单一玩法的游戏）
   */
  async getLeaderboard(slug: string, limit: number = 5, board?: string) {
    const game = await MGame.findOne({ slug }).lean(true);
    if (!game) return [];

    if (board) {
      // 只取在该玩法上有成绩的玩家，避免空成绩刷屏；score 用分榜分数返回给前端
      const players = await MPlayer.find({ game_id: game._id, [`boards.${board}`]: { $gt: 0 } })
        .limit(limit)
        .sort({ [`boards.${board}`]: -1, exp: -1 })
        .lean(true);
      return players.map(p => ({ ...p, score: p.boards?.[board] ?? 0, board_score: p.boards?.[board] ?? 0 }));
    }

    const players = await MPlayer.find({ game_id: game._id }).limit(limit).sort({ score: -1, exp: -1 }).lean(true)
    return players;
  }

  /**
   * 获取玩家统计
   */
  async getStats() {
    const key = config.prefix + 'stats:players'
    let stats: { [key: string]: string | number } = await redis.hgetall(key)
    if (isEmpty(stats)) {
      // 按 state（字符串枚举）分组，而不是 status（数字封禁状态）
      const players = await MPlayer.aggregate([{ $group: { _id: '$state', count: { $sum: 1 } } }]);

      const total = sumBy(players, 'count');
      const atline = await MPlayer.countDocuments({ atline: true });
      const playing = sumBy(players, (p) => [PlayerState.ingame, PlayerState.prepared, PlayerState.watching].includes(p._id) ? p.count : 0);

      stats = {
        total,
        atline,
        playing,
      };
      await redis.pipeline().hmset(key, stats).expire(key, config.expires).exec()
    }
    return stats;
  }
}

export const playerService = new PlayerService();