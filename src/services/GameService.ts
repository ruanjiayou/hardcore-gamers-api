/**
 * 游戏管理服务
 * 负责游戏的创建、查询、更新等操作
 */

import { v7 } from 'uuid';
import type { IGame } from '../types/index';
import { MGame, MMatch, MRoom } from '../models'
import { isEmpty, omit } from 'lodash';
import redis from '../utils/redis'
import config from '../config';
import constant from '../constant';
import GameLogics from '../games'
import { normalizeMode } from '../utils/gameMode'
import { snakeRuntimeService } from './SnakeRuntimeService'

export class GameService {

  /**
   * 获取所有游戏
   * 过滤 status=0（管理端下架）：老数据没有 status 字段，用 $ne:0 而不是 ===1
   */
  async getAllGames(stat: boolean): Promise<IGame[]> {
    const games = await MGame.find({ status: { $ne: 0 } }).lean(true).then(list => list.map(normalizeMode)) as unknown as IGame[];
    if (stat) {
      // 口径与 getRoomsByGameId 一致：排除已解散（deleted 软删）与临时（单人快开）的房间。
      // 否则解散后房间列表为空、但游戏卡片的房间数仍把软删房间计入（列表空、数量 1）。
      const list = await MRoom.aggregate([
        { $match: { status: { $ne: constant.ROOM.STATUS.deleted }, transient: { $ne: true } } },
        { $group: { _id: '$game_id', rooms: { $sum: 1 }, players: { $sum: { $size: '$members' } } } }])
      games.forEach(game => {
        const detail = list.find(v => v._id === game._id);
        if (detail) {
          game.rooms = detail.rooms;
          game.players = detail.players;
        } else {
          game.rooms = 0;
          game.players = 0;
        }
      })
    }
    return games;
  }

  /**
   * 按ID获取游戏
   */
  async getGameById(game_id: string): Promise<IGame | null> {
    const game = await MGame.findById(game_id).lean(true);
    return game ? normalizeMode(game) : null;
  }

  async getGameBySlug(slug: string) {
    const game = await MGame.findOne({ slug }).lean(true);
    return game ? normalizeMode(game) : null;
  }

  async getMatchState(game_slug: string, match_id: string) {
    const match = await MMatch.findById(match_id).lean(true);
    if (match) {
      // 实时对局（多人贪吃蛇）：以内存中的最新快照为准，避免读库拿到 0.5s 前的局面
      const live = snakeRuntimeService.snapshot(match_id);
      return ({ ...match.curr_state, ...(live ? { snake: live } : {}), players: match.players, match_id });
    } else {
      const state = GameLogics[game_slug].getInitState('');
      return { ...state, match_id }
    }
  }
  /**
   * 按类型获取游戏
   */
  async getGamesByGenre(genre: string): Promise<IGame[]> {
    return MGame.find({ genre, status: { $ne: 0 } }).lean(true)
  }

  /**
   * 创建新游戏
   */
  async createGame(data: Omit<IGame, '_id' | 'createdAt'>): Promise<IGame> {
    const game: IGame = {
      ...data,
      _id: v7(),
      createdAt: new Date(),
    };
    await MGame.create(game)
    return game;
  }

  /**
   * 更新游戏信息（房间数、玩家数等）
   */
  async updateGameStats(game_id: string, data: Partial<IGame>): Promise<void> {
    await MGame.updateOne({ _id: game_id }, { $set: omit(data, ['_id', 'createdAt']) })
  }

  /**
   * 获取游戏统计
   */
  async getStats() {
    const key = config.prefix + 'stats:games'
    let stats: { [key: string]: string | number } = await redis.hgetall(key)
    if (isEmpty(stats)) {
      const total = await MGame.countDocuments();
      stats = {
        total,
      };
      await redis.pipeline().hmset(key, stats).expire(key, config.expires).exec()
    }
    return stats;
  }
}

export const gameService = new GameService();