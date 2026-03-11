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
import GameLogics from '../games'

export class GameService {

  /**
   * 获取所有游戏
   */
  async getAllGames(stat: boolean): Promise<IGame[]> {
    const games = await MGame.find().lean(true)
    if (stat) {
      const list = await MRoom.aggregate([
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
    return MGame.findById(game_id).lean(true);
  }

  async getGameBySlug(name: string) {
    return MGame.findOne({ name }).lean(true)
  }

  async getMatchState(game_id: string, match_id: string) {
    const game = await MGame.findById(game_id).lean(true);
    if (!game) {
      return null;
    }
    const match = await MMatch.findById(match_id).lean(true);
    if (match) {
      return ({ ...match.curr_state, match_id });
    } else {
      const state = GameLogics[game.slug].getInitState('');
      return { ...state, match_id }
    }
  }
  /**
   * 按类型获取游戏
   */
  async getGamesByGenre(genre: string): Promise<IGame[]> {
    return MGame.find({ genre }).lean(true)
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
  async updateGameStats(name: string, data: Partial<IGame>): Promise<void> {
    await MGame.updateOne({ name }, { $set: omit(data, ['_id', 'createdAt']) })
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