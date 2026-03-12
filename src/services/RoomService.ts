/**
 * 房间管理服务 - 支持密码和自动解散
 */

import { v7 } from 'uuid';
import { IRoom, IPlayer, IRoleConfig, IMember } from '../types/index';
import { MGame, MMatch, MPlayer, MRoom } from '../models'
import { cloneDeep, isEmpty, sumBy } from 'lodash';
import redis from '../utils/redis'
import config from '../config';
import constant, { MatchStatus, PlayerState, RoomStatus } from '../constant'
import GameLogics from '../games'

export class RoomService {

  /**
   * 创建房间 - 支持密码
   */
  async createRoom(data: Partial<IRoom>) {
    data._id = v7();
    data.status = RoomStatus.waiting;
    data.createdAt = new Date();
    data.updatedAt = new Date();

    await MRoom.create(data);

    console.log(`✨ 房间创建: ${data._id} (${data.name}) ${data.isPrivate ? '🔒 私密' : '🔓 公开'}`);
    return data;
  }

  /**
   * 获取房间
   */
  async getRoomById(room_id: string): Promise<IRoom | null> {
    const room = await MRoom.findById(room_id).lean(true);
    return room || null;
  }

  /**
   * 获取游戏的所有房间
   */
  async getRoomsByGameId(game_id: string): Promise<IRoom[]> {
    const rooms = await MRoom.find({ game_id, status: RoomStatus.waiting }).lean(true);
    return rooms;
  }

  /**
   * 获取所有房间
   */
  async getAllRooms(): Promise<IRoom[]> {
    const rooms = await MRoom.find({ status: 1 }).lean(true);
    return rooms;
  }

  /**
   * 验证房间密码
   */
  async verifyPassword(room_id: string, password: string) {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return false;

    if (!room.isPrivate) return true; // 公开房间无需密码

    return room.password === password;
  }

  /**
   * 玩家加入房间 - 支持密码验证
   */
  async joinRoom(room_id: string, watch_id: string, player: IPlayer, password?: string): Promise<{ success: boolean, newPlayer?: IMember }> {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return { success: false };
    const game = await MGame.findById(room.game_id).lean(true)
    if (!game) return { success: false };

    // 检查玩家是否已在房间中
    if (room.members.some(p => p._id === player._id)) {
      return { success: true };
    }
    const players = room.members.filter(m => !m.watch_id);
    if (!watch_id) {
      // 检查房间是否已满
      if (players.length >= room.numbers.max) {
        console.log(`❌ 房间已满: ${room_id}`);
        return { success: false };
      }

      // 检查房间状态
      if (room.status !== RoomStatus.waiting) {
        console.log(`❌ 房间游戏已开始: ${room_id}`);
        return { success: false };
      }

    }
    // 验证密码
    if (room.isPrivate && !this.verifyPassword(room_id, password || '')) {
      console.log(`❌ 房间密码错误: ${room_id}`);
      return { success: false };
    }
    const newPlayer = { _id: player._id, watch_id, type: player.type, role: '' }
    GameLogics[game.slug].assignRole(room, newPlayer)
    const diff = { owner_id: room.owner_id, members: cloneDeep(room.members) }
    if (!watch_id && room.members.length === 0) {
      diff.owner_id = player._id;
    }
    diff.members.push(newPlayer)
    await MRoom.updateOne({ _id: room._id }, { $set: diff })
    console.log(`👤 玩家 ${player._id} 加入房间 ${room_id}，当前人数: ${diff.members.length}`);
    return { success: true, newPlayer };
  }

  /**
   * 玩家离开房间
   */
  async leaveRoom(room_id: string, player_id: string): Promise<IMember[]> {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return [];
    const idx = room.members.findIndex(m => m._id === player_id);
    if (-1 === idx) return [];
    const old_list = cloneDeep(room.members.filter(m => m._id === player_id));
    let owner_id = room.owner_id;
    if (player_id === owner_id) {
      const next = room.members.find(m => !m.watch_id);
      owner_id = next ? next._id : '';
    }
    await MRoom.updateOne({ _id: room._id }, { $set: { owner_id, members: room.members.filter(m => m._id !== player_id) } })
    await MPlayer.updateOne({ _id: player_id }, { $set: { room_id: '', state: PlayerState.online } })
    console.log(`👤 玩家 ${player_id} 离开房间 ${room_id}，当前人数: ${room.members.length - 1}`);

    const changes: IMember[] = [];
    room.members.forEach(member => {
      const old = old_list.find(o => o._id === member._id);
      if (old && old.role !== member.role) {
        changes.push(member);
      }
    })
    return changes;
  }

  /**
   * 开始游戏
   */
  async startGame(room_id: string, player_id: string) {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return '';
    console.log('start game', player_id)
    const game = await MGame.findById(room.game_id).lean(true);
    if (!game) {
      return '';
    }
    const players = room.members.filter(m => !m.watch_id);
    const player = players.find(p => p._id === player_id);
    if (!player) {
      return '';
    }

    if (players.length < room.numbers.min) {
      return '';
    }

    if (players.length < room.numbers.min) {
      return '';
    }
    const state = GameLogics[game.slug].getInitState(player_id);
    const match_id = v7();
    await MMatch.create({
      _id: match_id,
      game_id: room.game_id,
      room_id: room._id,
      status: MatchStatus.playing,
      init_state: { ...state },
      curr_state: { ...state },
      players: GameLogics[game.slug]?.assignRoles(players),
      createdAt: new Date(),
      updatedAt: new Date(),
      stats: {},
    })

    await MRoom.updateOne({ _id: room_id }, {
      $set: {
        match_id,
        status: RoomStatus.playing,
        startedAt: new Date(),
      }
    })
    await MPlayer.bulkWrite(room.members.map(m => ({
      updateOne: {
        filter: { _id: m._id },
        update: {
          $set: {
            state: m.watch_id ? PlayerState.watching : PlayerState.ingame,
            room_id: room._id,
          }
        }
      }
    })))
    console.log(`🎮 房间 ${room_id} 开始游戏，玩家数: ${players.length}`);
    return match_id;
  }

  async gameover(room_id: string, match_id: string, winner_player_id: string) {
    await MRoom.updateOne(
      {
        _id: room_id
      },
      {
        $set: {
          status: 'waiting',
          match_id: '',
          updatedAt: new Date(),
        }
      });
    const match = await MMatch.findOne({ _id: match_id }).lean(true);
    if (match) {
      await MMatch.updateOne(
        { _id: match._id },
        {
          $set: {
            status: MatchStatus.gameover,
            updatedAt: new Date(),
            players: match.players.map(p => ({ ...p, score: p._id === winner_player_id ? 1 : -1 })),
          }
        });
      await MPlayer.bulkWrite(match.players.map(p => ({
        updateOne: {
          filter: { _id: p._id },
          update: {
            state: PlayerState.inroom,
            room_id: '',
            $inc: {
              'stats.games': 1,
              'stats.matches': 1,
              score: p._id === winner_player_id ? 1 : -1,
              'stats.winners': p._id === winner_player_id ? 1 : 0,
            }
          },
        }
      })));
    }
  }

  /**
   * 销毁房间
   */
  async destroyRoom(room_id: string) {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return;
    await MRoom.updateOne({ _id: room_id }, { $set: { status: RoomStatus.deleted } });
    console.log(`🗑️  房间解散: ${room_id}`);
    return room;
  }

  async playerReady(room_id: string, ready: boolean, player_id: string) {
    console.log(`切换准备状态`, player_id, ready)
    const room = await MRoom.findById(room_id).lean(true);
    if (!room || room.status === RoomStatus.playing) {
      return { success: false, roomReady: false };
    }
    await MPlayer.updateOne({ _id: player_id }, { $set: { state: ready ? constant.PLAYER.STATE.prepared : constant.PLAYER.STATE.inroom } });
    const ids = room.members.filter(m => !m.watch_id).map(m => m._id);
    const players = await MPlayer.find({ _id: { $in: ids } }, { state: 1 }).lean(true)
    const readys = sumBy(players, p => p.state === PlayerState.prepared ? 1 : 0);

    const roomReady = readys === players.length && readys >= room.numbers.min
    if (roomReady) {
      await MRoom.updateOne({ _id: room_id, }, { $set: { status: RoomStatus.readied } })
    }
    return { success: true, roomReady };
  }

  /**
   * 获取房间统计
   */
  async getStats() {
    const key = config.prefix + 'stats:room'
    let stats: { [key: string]: string | number } = await redis.hgetall(key)
    if (isEmpty(stats)) {
      const summary = await MRoom.aggregate([{ $group: { _id: '$status', total: { $sum: 1 } } }]);
      const waits = summary.find(v => v._id === 'waiting')?.total || 0;
      const finishedRooms = summary.find(v => v._id === 'finished')?.total || 0;
      stats = {
        active: sumBy(summary, 'total') - finishedRooms,
        waits,
      }
      await redis.pipeline().hmset(key, stats).expire(key, config.expires).exec()
    }
    return stats;
  }
}

export const roomService = new RoomService();