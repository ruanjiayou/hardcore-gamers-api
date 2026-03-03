/**
 * 房间管理服务 - 支持密码和自动解散
 */

import { v7 } from 'uuid';
import type { IRoom, IPlayer, RoomStatus, IRoleConfig, IMember } from '../types/index';
import { MMatch, MPlayer, MRoom } from '../models'
import { cloneDeep, isEmpty, sumBy } from 'lodash';
import redis from '../utils/redis'
import config from '../config';
import constant from '../constant'
import GameLogics from '../games'

export class RoomService {

  /**
   * 创建房间 - 支持密码
   */
  async createRoom(data: Partial<IRoom>) {
    data._id = v7();
    data.status = 'waiting'
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
  async getRoomsByGameId(gameId: string): Promise<IRoom[]> {
    const rooms = await MRoom.find({ gameId, status: { $ne: 'closed' } }).lean(true);
    return rooms;
  }

  /**
   * 获取所有房间
   */
  async getAllRooms(): Promise<IRoom[]> {
    const rooms = await MRoom.find({ status: { $ne: 'closed' } }).lean(true);
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
  async joinRoom(room_id: string, type: string, player: IPlayer, password?: string): Promise<{ success: boolean, newPlayer?: IPlayer }> {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return { success: false };

    // 检查玩家是否已在房间中
    if (room.members.some(p => p._id === player._id)) {
      return { success: true };
    }
    const players = room.members.filter(m => m.type === constant.MEMBER.TYPE.player);
    if (type === 'player') {
      // 检查房间是否已满
      if (players.length >= room.numbers.max) {
        console.log(`❌ 房间已满: ${room_id}`);
        return { success: false };
      }

      // 检查房间状态
      if (room.status === 'playing' || room.status === 'loading') {
        console.log(`❌ 房间游戏已开始: ${room_id}`);
        return { success: false };
      }

    }
    // 验证密码
    if (room.isPrivate && !this.verifyPassword(room_id, password || '')) {
      console.log(`❌ 房间密码错误: ${room_id}`);
      return { success: false };
    }
    const newPlayer = { ...player, state: players.length === 0 ? 'ready' : 'idle', type, is_robot: false }
    GameLogics.Xiangqi.assignRole(room, newPlayer)
    room.members.push(newPlayer)
    const diff = { owner_id: room.owner_id, members: cloneDeep(room.members) }
    await MRoom.updateOne({ _id: room._id }, { $set: diff })
    await MPlayer.updateOne({ _id: player._id }, { $set: { room_id: room._id } })
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
    GameLogics.Xiangqi.assignRoles(room);
    console.log(room_id, player_id)
    await MRoom.updateOne({ _id: room._id }, { $set: { members: room.members.filter(m => m._id !== player_id) } })
    await MPlayer.updateOne({ _id: player_id }, { $set: { room_id: '' } })
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

    const players = room.members.filter(m => m.type === constant.MEMBER.TYPE.player);
    const player = players.find(p => p._id === player_id);
    if (!player) {
      return '';
    }

    if (room.owner_id !== player.user_id) {
      return '';
    }

    if (players.length < room.numbers.min) {
      return '';
    }

    if (players.length < room.numbers.min) {
      return '';
    }
    const allReady = players.findIndex(p => p.state != 'ready') === -1;
    if (!allReady) {
      return '';
    }
    // room.players = await this.assignRole({ mode: 'fixed', roles: [] }, players)
    room.status = 'playing';
    room.startedAt = new Date();
    await MRoom.updateOne({ _id: room_id }, { $set: { status: 'playing', startedAt: new Date() } })
    const state = GameLogics['Xiangqi']?.getInitState(room);
    const match_id = v7();
    await MMatch.create({
      _id: match_id,
      game_id: room.gameId,
      room_id: room._id,
      status: 'playing',
      init_state: state,
      curr_state: state,
      players: players,
      createdAt: new Date(),
      updatedAt: new Date(),
      stats: {},
    })
    console.log(`🎮 房间 ${room_id} 开始游戏，玩家数: ${players.length}`);
    return match_id;
  }

  async assignRole(roleConfig: IRoleConfig, players: IMember[]) {
    switch (roleConfig.mode) {
      case "fixed":
        players.forEach((p, idx) => {
          p.role = roleConfig.roles[idx].name;
        })
        return players
      case "team":
        return [];
      case "custom":
        return [];
    }
  }

  async surrender(data: { room_id: string, match_id: string, player_id: string }) {
    const room = await MRoom.findOne({ _id: data.room_id, status: 'playing' }).lean(true);
    await MRoom.updateOne(
      {
        _id: data.room_id
      },
      {
        $set: {
          status: 'waiting',
          updatedAt: new Date(),
          members: room?.members.map(p => {
            p.state = p.type === constant.MEMBER.TYPE.player && p.user_id === room.owner_id ? 'ready' : 'idle';
            return p;
          })
        }
      });
    const match = await MMatch.findOne({ room_id: data.room_id, status: 'playing' }).lean(true);
    if (match) {
      await MMatch.updateOne({ _id: match._id }, { $set: { status: 'finished', updatedAt: new Date() } });
    }
  }
  /**
   * 房间是否已满
   */
  async isRoomFull(room_id: string) {
    const room = await MRoom.findById(room_id).lean(true);
    return room ? room.members.filter(m => m.type === constant.MEMBER.TYPE.player).length >= room.numbers.max : false;
  }

  /**
   * 销毁房间
   */
  async destroyRoom(room_id: string) {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return;
    await MRoom.updateOne({ _id: room_id }, { $set: { status: 'finished' } });
    console.log(`🗑️  房间解散: ${room_id}`);
    return room;
  }

  async playerReady(room_id: string, ready: boolean, player_id: string) {
    console.log(`切换准备状态`, player_id, ready)
    const room = await MRoom.findById(room_id).lean(true);
    if (!room || room.status === 'playing') {
      return { success: false, roomReady: false };
    }
    const players = room.members.filter(m => m.type === constant.MEMBER.TYPE.player);
    const player = players.find(p => p._id === player_id);
    if (!player) {
      return { success: false, roomReady: false };
    }
    player.state = ready ? 'ready' : 'idle';
    const readys = sumBy(players, p => p.state === 'ready' ? 1 : 0);
    const roomReady = readys === players.length && readys >= room.numbers.min
    await MRoom.updateOne({ _id: room_id, 'players._id': player._id }, { $set: { members: room.members, status: roomReady ? 'ready' : 'waiting' } })
    return { success: true, roomReady };
  }
  /**
   * 更新房间状态
   */
  async updateRoomStatus(room_id: string, status: RoomStatus) {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return false;

    await MRoom.updateOne({ _id: room_id }, { $set: { status } });
    return true;
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