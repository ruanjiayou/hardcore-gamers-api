/**
 * 房间事件处理
 */

import type { Server } from 'socket.io';
import { CB } from '../types';
import { roomService } from '../services/RoomService';
import type { AuthSocket } from '../middleware/auth';
import constant from '../constant'
import { MMatch } from '../models';
import GameLogics from '../games'

export function setupRoomHandlers(io: Server, socket: AuthSocket, user_id: string) {
  const isLoggedIn = socket.isLoggedIn;

  socket.on('room:get-info', getRoomInfo);
  socket.on('room:update-settings', updateRoom);
  socket.on('room:send-message', sendMessage);
  socket.on('room:kick-player', kickPlayer,);
  socket.on('room:leave', leaveRoom);
  socket.on('room:player-ready', playerReadyChange)
  socket.on('room:start-game', startGame);
  socket.on('room:get-match-state', getMatchState);
  socket.on('room:surrender', surrender);
  socket.on('room:close', closeRoom)

  async function getRoomInfo(data: { room_id: string }, cb: CB) {
    const { room_id } = data;
    const roomInfo = await roomService.getRoomById(room_id);
    cb(roomInfo);
  }
  /**
   * 发送房间消息
   * @description 判断条件是否满足,向房间发送消息同步数据
   */
  async function sendMessage(data: { room_id: string; message: string }, callback: (success: boolean) => void) {
    console.log(`玩家发言 ${data.room_id} ${data.message}`)
    if (!socket.isLoggedIn) {
      callback(false);
      return;
    }

    const { room_id, message } = data;
    const room = await roomService.getRoomById(room_id);
    if (!room || !message) {
      callback(false);
      return;
    }
    const player = room.members.find(p => p.type === constant.MEMBER.TYPE.player && p.user_id === user_id);

    if (!player) {
      callback(false);
      return;
    }
    callback(true);

    console.log('广播')
    io.to(`room:${room_id}`).emit('room:message', {
      player_id: player._id,
      player_name: player.user_name,
      message,
      timestamp: Date.now()
    });

  }
  /**
   * 房主开始游戏
   * @description 判断条件是否满足,修改房间状态,分配位置,向房间发送通知(初始状态数据和玩家分配信息)
   */
  async function startGame(data: { room_id: string, player_id: string }, callback: (match_id: string, error?: string) => void) {
    if (!socket.isLoggedIn) {
      callback('', '需要登陆');
      return;
    }

    const { room_id } = data;
    const room = await roomService.getRoomById(room_id);
    if (!room) {
      callback('', '房间或玩家不存在');
      return;
    }
    try {
      const match_id = await roomService.startGame(room_id, data.player_id);
      if (!match_id) {
        callback(match_id, '开始游戏失败');
        return;
      }

      callback(match_id);

      io.to(`room:${room_id}`).emit('room:game-started', {
        room_id,
        playerCount: room.members.length,
        timestamp: Date.now()
      });

    } catch (error) {
      console.log(error)
      callback('', '开始游戏报错');
    }
  }

  async function getMatchState(data: { room_id: string, match_id: string, player_id: string }) {
    const match = await MMatch.findOne({ room_id: data.room_id, _id: data.match_id }).lean(true);
    return match?.curr_state;
  }

  /**
   * 房主踢出玩家
   */
  async function kickPlayer(data: { room_id: string; player_id: string }, callback: (success: boolean) => void) {
    const user_id = socket.user_id || '';
    if (!socket.isLoggedIn || !user_id) {
      callback(false);
      return;
    }

    const { room_id, player_id } = data;
    const room = await roomService.getRoomById(room_id);

    if (!room || room.owner_id !== user_id) {
      callback(false);
      return;
    }

    try {
      const success = await roomService.leaveRoom(room_id, player_id);

      if (!success) {
        callback(false);
        return;
      }

      // 通知被踢的玩家
      io.to(player_id).emit('room:kicked', {
        room_id,
        message: '你已被房主踢出房间'
      });

      // 通知房间内其他玩家
      if (success) {
        io.to(`room:${room_id}`).emit('room:player-kicked', {
          player_id: player_id,
        });
      }

      callback(true);
      console.log(`👢 玩家 ${user_id} 被从房间 ${room_id} 踢出`);
    } catch (error) {
      callback(false);
    }
  }
  /**
   * 玩家切换准备状态
   * @description 玩家改变自己的状态(只能是非游戏时),准备/取消准备.返回 success 表示是否改变成功.通知房间 roomReady 表示是否所有人已准备(以便房主开始游戏)
   */
  async function playerReadyChange(data: { room_id: string; player_id: string; ready: boolean }, callback: (success: boolean) => void) {
    const user_id = socket.user_id || '';
    if (!socket.isLoggedIn || !user_id) {
      callback(false);
      return;
    }

    const { room_id, ready } = data;
    const room = await roomService.getRoomById(room_id);

    if (!room) {
      callback(false);
      return;
    }

    try {
      const { success, roomReady } = await roomService.playerReady(room_id, ready, data.player_id);

      callback(success);
      if (success) {
        io.to(`room:${room_id}`).emit('room:room-ready', roomReady)
        console.log(`🏠 房间 ${room_id} ${roomReady ? "已就绪" : "未就绪"}`);
      }
    } catch (error) {
      callback(false);
    }
  }
  /**
   * 更新房间设置
   */
  async function updateRoom(data: { room_id: string; settings: Record<string, any> }, callback: (success: boolean) => void) {
    if (!socket.isLoggedIn) {
      callback(false);
      return;
    }

    const { room_id, settings } = data;
    const room = await roomService.getRoomById(room_id);

    if (!room || room.owner_id !== socket.user_id) {
      callback(false);
      return;
    }

    try {
      room.settings = { ...room.settings, ...settings };

      io.to(`room:${room_id}`).emit('room:settings-updated', {
        settings: room.settings
      });

      callback(true);
    } catch (error) {
      callback(false);
    }
  }
  /**
   * 认输
   * @description 修改房间状态为 waiting,非房主状态为 idle,对局match结束,向房间所有人发送消息和 room 最新数据
   */
  async function surrender(data: { room_id: string; match_id: string, player_id: string }, callback: (success: boolean) => void) {
    const room = await roomService.getRoomById(data.room_id);
    if (!room) {
      callback(false);
      return;
    }
    const player = room.members.find(p => p._id === data.player_id);
    if (!player) {
      callback(false);
      return;
    }
    try {
      await roomService.surrender(data);
      callback(true);
      console.log(`🏡 ${room._id} 👤 玩家 ${player.user_id} 认输`);

      io.to(`room:${room._id}`).emit('room:player-surrender', { room_id: room._id, player_id: player._id, player_name: player.user_name });

    } catch (error) {
      console.log(error, 'err')
      callback(false);
    }
  }
  /**
   * 离开房间
   * @description 判断玩家是不是房间中的人,离开操作 从房间中去掉该玩家,并重置游戏玩家的当前房间.向房间发送消息
   */
  async function leaveRoom(data: { room_id: string; player_id: string }, callback: (success: boolean) => void) {
    if (!isLoggedIn) {
      callback(false);
      return;
    }

    try {
      const players = await roomService.leaveRoom(data.room_id, data.player_id);
      callback(true);

      socket.room_id = undefined;
      socket.leave(`room:${data.room_id}`);
      socket.leave(`user:${user_id}`);
      io.to(`room:${data.room_id}`).emit('room:player-leaved', { room_id: data.room_id, player_id: data.player_id });
      console.log(`👤 玩家 ${data.player_id} 离开房间 ${data.room_id}`);
      players.forEach(p => {
        io.to(`user:${p.user_id}`).emit('room:player-change', p);
      })
    } catch (error) {
      console.log(error, 'err')
      callback(false);
    }
  }

  async function closeRoom(data: { room_id: string }, cb: Function) {
    const room = await roomService.destroyRoom(data.room_id);
    if (room) {
      // 房间已解散，通知游戏中的其他玩家
      socket.leave(`game:${room?.gameId}`);
      io.to(`game:${room?.gameId}`).emit('lobby:room-destroyed', {
        room_id: room._id
      });
      cb(true);
    } else {
      cb(false);
    }
  }
}