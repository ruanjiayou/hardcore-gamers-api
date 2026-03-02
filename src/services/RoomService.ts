/**
 * 房间管理服务 - 支持密码和自动解散
 */

import { v7 } from 'uuid';
import type { IRoom, IPlayer, RoomStatus, IRoleConfig, IMember } from '../types/index';
import { MPlayer, MRoom } from '../models'
import { isEmpty, sumBy } from 'lodash';
import redis from '../utils/redis'
import config from '../config';
import constant from '../constant'

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
  async getRoomById(roomId: string): Promise<IRoom | null> {
    const room = await MRoom.findById(roomId).lean(true);
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
  async verifyPassword(roomId: string, password: string) {
    const room = await MRoom.findById(roomId).lean(true);
    if (!room) return false;

    if (!room.isPrivate) return true; // 公开房间无需密码

    return room.password === password;
  }

  /**
   * 玩家加入房间 - 支持密码验证
   */
  async joinRoom(roomId: string, player: IPlayer, password?: string) {
    const room = await MRoom.findById(roomId).lean(true);
    if (!room) return false;

    const players = room.members.filter(m => m.type === constant.MEMBER.TYPE.player);
    // 检查房间是否已满
    if (players.length >= room.numbers.max) {
      console.log(`❌ 房间已满: ${roomId}`);
      return false;
    }

    // 检查房间状态
    if (room.status === 'playing' || room.status === 'loading') {
      console.log(`❌ 房间游戏已开始: ${roomId}`);
      return false;
    }

    // 验证密码
    if (room.isPrivate && !this.verifyPassword(roomId, password || '')) {
      console.log(`❌ 房间密码错误: ${roomId}`);
      return false;
    }

    // 检查玩家是否已在房间中
    if (players.some(p => p._id === player._id)) {
      return false;
    }
    const diff = { owner_id: room.owner_id, members: players }
    // 第一个进入的自动成为房主
    if (players.length === 0) {
      player.user_id;
    }
    const room_player = { ...player, state: players.length === 0 ? 'ready' : 'idle', type: 'play', is_robot: false }
    diff.members.push(room_player)
    await MRoom.updateOne({ _id: room._id }, { $set: diff })
    await MPlayer.updateOne({ _id: room_player._id }, { $set: { room_id: room._id } })
    console.log(`👤 玩家 ${player._id} 加入房间 ${roomId}，当前人数: ${diff.members.length}`);
    return true;
  }

  /**
   * 玩家离开房间
   */
  async leaveRoom(roomId: string, playerId: string): Promise<boolean> {
    const room = await MRoom.findById(roomId).lean(true);
    if (!room) return false;

    const playerIndex = room.members.findIndex(p => p._id === playerId);
    if (playerIndex === -1) return false;

    const player = room.members[playerIndex];
    room.members.splice(playerIndex, 1);
    await MRoom.updateOne({ _id: room._id }, { $set: { members: room.members } })
    await MPlayer.updateOne({ _id: player._id }, { $set: { room_id: '' } })
    console.log(`👤 玩家 ${player.user_id} 离开房间 ${roomId}，当前人数: ${room.members.length}`);

    return true;
  }

  /**
   * 开始游戏
   */
  async startGame(roomId: string, player_id: string) {
    const room = await MRoom.findById(roomId).lean(true);
    if (!room) return false;

    const players = room.members.filter(m => m.type === constant.MEMBER.TYPE.player);
    const player = players.find(p => p._id === player_id);
    if (!player) {
      return false;
    }

    if (room.owner_id !== player.user_id) {
      return false;
    }

    if (players.length < room.numbers.min) {
      return false;
    }

    if (players.length < room.numbers.min) {
      return false;
    }
    const allReady = players.findIndex(p => p.state != 'ready') === -1;
    if (!allReady) {
      return false;
    }
    // room.players = await this.assignRole({ mode: 'fixed', roles: [] }, players)
    room.status = 'playing';
    room.startedAt = new Date();
    await MRoom.updateOne({ _id: roomId }, { $set: { status: 'playing', startedAt: new Date() } })

    console.log(`🎮 房间 ${roomId} 开始游戏，玩家数: ${players.length}`);
    return true;
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

  async surrender(roomId: string, playerId: string) {
    const room = await MRoom.findOne({ _id: roomId }).lean(true);
    await MRoom.updateOne(
      {
        _id: roomId
      },
      {
        $set: {
          status: 'waiting',
          players: room?.members.map(p => {
            p.state = p.type === constant.MEMBER.TYPE.player && p.user_id === room.owner_id ? 'ready' : 'idle';
            return p;
          })
        }
      });

  }
  /**
   * 房间是否已满
   */
  async isRoomFull(roomId: string) {
    const room = await MRoom.findById(roomId).lean(true);
    return room ? room.members.filter(m => m.type === constant.MEMBER.TYPE.player).length >= room.numbers.max : false;
  }

  /**
   * 销毁房间
   */
  async destroyRoom(roomId: string) {
    const room = await MRoom.findById(roomId).lean(true);
    if (!room) return;
    await MRoom.updateOne({ _id: roomId }, { $set: { status: 'finished' } });
    console.log(`🗑️  房间解散: ${roomId}`);
    return room;
  }

  async playerReady(roomId: string, ready: boolean, player_id: string) {
    console.log(`切换准备状态`, player_id, ready)
    const room = await MRoom.findById(roomId).lean(true);
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
    await MRoom.updateOne({ _id: roomId, 'players._id': player._id }, { $set: { members: room.members, status: roomReady ? 'ready' : 'waiting' } })
    return { success: true, roomReady };
  }
  /**
   * 更新房间状态
   */
  async updateRoomStatus(roomId: string, status: RoomStatus) {
    const room = await MRoom.findById(roomId).lean(true);
    if (!room) return false;

    await MRoom.updateOne({ _id: roomId }, { $set: { status } });
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