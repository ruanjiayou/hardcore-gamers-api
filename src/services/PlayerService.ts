/**
 * 玩家管理服务
 * 负责玩家的创建、查询、更新等操作
 */

import { v7 } from 'uuid';
import { MGame, MPlayer, MRoom, MUser } from '../models';
import redis from '../utils/redis'
import config from '../config';
import { isEmpty, sumBy } from 'lodash';
import constant, { PlayerState, RoomStatus } from '../constant';

export class PlayerService {

  /**
   * 校正玩家的 room_id：房间已不存在 / 已软删 / 玩家已不在成员列表时清空。
   * 悬空引用会让前端"进入游戏"直接跳到不存在的房间，弹出"房间不存在"。
   * 只在读取玩家时顺手修，不做全表扫描（全表修复见 repairDanglingRooms）。
   */
  async sanitizePlayerRoom<T extends { _id: string; room_id?: string }>(player: T): Promise<T> {
    if (!player?.room_id) return player;
    const room = await MRoom.findById(player.room_id).lean(true) as any;
    const alive = room
      && room.status !== constant.ROOM.STATUS.deleted
      && (room.members || []).some((m: any) => m._id === player._id);
    if (alive) return player;
    await MPlayer.updateOne(
      { _id: player._id },
      { $set: { room_id: '', state: constant.PLAYER.STATE.online } },
    );
    return { ...player, room_id: '', state: constant.PLAYER.STATE.online };
  }

  /**
   * 全表修复悬空的玩家 room_id（服务启动时调用一次）。
   * 直接用 Mongo 聚合比对，避免逐个玩家的往返查询。
   */
  async repairDanglingRooms(): Promise<number> {
    const stale = await MPlayer.aggregate([
      { $match: { room_id: { $nin: ['', null] } } },
      {
        $lookup: {
          from: 'rooms',
          localField: 'room_id',
          foreignField: '_id',
          as: 'room',
        },
      },
      {
        $match: {
          $or: [
            { room: { $size: 0 } },
            { 'room.status': constant.ROOM.STATUS.deleted },
          ],
        },
      },
      { $project: { _id: 1 } },
    ]);
    const ids = stale.map((p: any) => p._id);
    if (!ids.length) return 0;
    await MPlayer.updateMany(
      { _id: { $in: ids } },
      { $set: { room_id: '', state: constant.PLAYER.STATE.online } },
    );
    console.log(`🧹 清理悬空 room_id 的玩家: ${ids.length}`);
    return ids.length;
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
    let player = await MPlayer.findOne({ user_id, game_id: game._id }).lean(true);
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
   * @param board 可选分榜 key（如贪吃蛇 endless/multi）：按 boards.<key> 最高分排序；
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