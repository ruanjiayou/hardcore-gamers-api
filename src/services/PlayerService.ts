/**
 * 玩家管理服务
 * 负责玩家的创建、查询、更新等操作
 */

import { v7 } from 'uuid';
import { MGame, MPlayer, MUser } from '../models';
import redis from '../utils/redis'
import config from '../config';
import { isEmpty, sumBy } from 'lodash';
import constant, { PlayerState, RoomStatus } from '../constant';

export class PlayerService {

  /**
   * 创建或获取玩家
   */
  async getOrCreatePlayer(user_id: string, name: string) {
    const game = await MGame.findOne({ $or: [{ _id: name }, { slug: name }] })
    if (!game) {
      throw new Error('游戏不存在')
    }
    // 如果玩家已存在，返回该玩家
    let player = await MPlayer.findOne({ user_id, game_id: game._id }).lean(true);
    if (player) {
      return player;
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

    console.log(`✨ 新玩家创建:  (${player._id})`);
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
  async updatePlayerStatus(player_id: string, status: string) {
    await MPlayer.updateOne({ _id: player_id }, { $set: { status } })
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
   */
  async getLeaderboard(slug: string, limit: number = 5) {
    const game = await MGame.findOne({ slug }).lean(true);
    if (game) {
      const players = await MPlayer.find({ game_id: game._id }).limit(limit).sort({ score: -1, exp: -1 }).lean(true)
      return players;
    } else {
      return [];
    }
  }

  /**
   * 获取玩家统计
   */
  async getStats() {
    const key = config.prefix + 'stats:players'
    let stats: { [key: string]: string | number } = await redis.hgetall(key)
    if (isEmpty(stats)) {
      const players = await MPlayer.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);

      const total = sumBy(players, 'count');
      const atline = await MPlayer.countDocuments({ atline: true });
      const playing = sumBy(players, (p) => [PlayerState.ingame, PlayerState.ingame, PlayerState.prepared].includes(p._id) ? p.count : 0);

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