/**
 * 房间事件处理
 */

import type { Server } from 'socket.io';
import { CB, IMember } from '../types';
import { roomService } from '../services/RoomService';
import type { AuthSocket } from '../middleware/auth';
import constant, { PlayerType, RoomStatus } from '../constant'
import { MGame, MMatch, MPlayer, MRoom } from '../models';
import GameLogics from '../games'
import robots from '../games/robot';
import { gameService } from '../services/GameService';
import { pick } from 'lodash';

export function setupRoomHandlers(io: Server, socket: AuthSocket, user_id: string) {
  const isLoggedIn = socket.isLoggedIn;

  socket.on('room:detail', getRoomDetail);
  socket.on('room:update-settings', updateRoom);
  socket.on('room:send-message', sendMessage);
  socket.on('room:kick-player', kickPlayer);
  socket.on('room:transferor-owner', transferOwner);
  socket.on('room:add-robot', addRobot,);
  socket.on('room:leave', leaveRoom);
  socket.on('room:player-ready', playerReadyChange)
  socket.on('room:player-action', playerAction)
  socket.on('room:start-game', startGame);
  socket.on('room:get-match-state', getMatchState);
  socket.on('room:player-surrender', surrender);
  socket.on('room:disband', closeRoom)

  async function getRoomDetail(data: { room_id: string }, cb: CB) {
    const { room_id } = data;
    const room = await roomService.getRoomById(room_id);
    let match_id = '';
    if (room) {
      const members = await MPlayer.find({ _id: { $in: room.members.map(m => m._id) } }).lean(true)
      room.members = room.members.map(m => {
        const player = members.find(p => p._id === m._id)
        return { ...player, ...m }
      });
    }
    if (room && room.status === constant.ROOM.STATUS.playing) {
      const match = await MMatch.findOne({ room_id, status: constant.MATCH.STATUS.playing }, { _id: 1 }).lean();
      match_id = match ? match._id : ''
    }
    cb({ room, match_id })
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
    const player = await MPlayer.findOne({ user_id, game_id: room.game_id }).lean(true)

    if (!player) {
      callback(false);
      return;
    }
    callback(true);

    console.log('广播')
    io.to(`room:${room_id}`).emit('room:message', {
      player_id: player._id,
      player_name: player.nickname,
      message,
      timestamp: Date.now()
    });

  }
  /**
   * 房主开始游戏
   * @description 判断条件是否满足,修改房间状态,分配位置,向房间发送通知(初始状态数据和玩家分配信息)
   */
  async function startGame(data: { room_id: string, player_id: string }, callback: (success: boolean) => void) {
    if (!socket.isLoggedIn) {
      return callback(false);
    }

    const { room_id } = data;
    const room = await roomService.getRoomById(room_id);
    if (!room) {
      return callback(false);
    }
    try {
      const match_id = await roomService.startGame(room_id, data.player_id);
      if (!match_id) {
        return callback(false);
      }

      callback(true);
      io.to(`room:${room_id}`).emit('room:game-start', {
        room_id,
        match_id,
        curr_turn: data.player_id,
        timestamp: Date.now()
      });
    } catch (error) {
      console.log(error)
      callback(false);
    }
  }

  async function getMatchState(data: { game_id: string, match_id: string }, callback: (state: any) => void) {
    const result = await gameService.getMatchState(data.game_id, data.match_id)
    callback(result);
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
    try {
      const success = await roomService.kickPlayer(room_id, player_id);

      if (!success) {
        callback(false);
        return;
      }
      callback(true);

      // 通知房间内其他玩家
      io.to(`room:${room_id}`).emit('room:player-kicked', { player_id });
      console.log(`👢 玩家 ${player_id} 被从房间 ${room_id} 踢出`);
    } catch (error) {
      console.log(error)
      callback(false);
    }
  }
  /**
   * 转让房主
   */
  async function transferOwner(data: { room_id: string; player_id: string }, callback: (success: boolean) => void) {
    const user_id = socket.user_id || '';
    if (!socket.isLoggedIn || !user_id) {
      callback(false);
      return;
    }

    const { room_id, player_id } = data;
    try {
      const success = await roomService.transferOwner(room_id, player_id);
      if (!success) {
        return callback(false);
      }
      callback(true);
      io.to(`room:${room_id}`).emit('room:transferee-owner', { player_id });
      console.log(`房间 ${room_id} 被转让给 ${player_id}`)
    } catch (error) {
      callback(false)
    }
  }
  async function addRobot(data: { room_id: string; }, callback: (success: boolean) => void) {
    const room = await MRoom.findById(data.room_id).lean(true);
    if (room) {
      const available_robot = await MPlayer.findOne({ game_id: room.game_id, type: constant.PLAYER.TYPE.robot, state: constant.PLAYER.STATE.online }).lean(true);
      if (available_robot) {
        callback(true);
        const result = await roomService.joinRoom(data.room_id, '', available_robot)
        await MPlayer.updateOne({ _id: available_robot._id }, { $set: { room_id: data.room_id, state: constant.PLAYER.STATE.prepared } })
        io.to(`room:${data.room_id}`).emit('room:player-joined', available_robot);
      } else {
        callback(false)
      }
    } else {
      callback(false)
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
      if (roomReady) {
        startGame(data, () => {
          console.log('自动开始')
        });
      }
    } catch (error) {
      callback(false);
    }
  }
  async function playerAction(match_id: string, movement: { player_id: string, from: [number, number], to: [number, number] }, callback: (success: boolean) => void) {
    const player = await MPlayer.findById(movement.player_id);
    if (!player || player.user_id !== user_id) {
      return callback(false);
    }
    const match = await MMatch.findOne({ _id: match_id }).lean(true);
    if (match) {
      const game = await MGame.findById(match.game_id).lean(true);
      if (!game) return callback(false)
      const { success, gameover, data, board } = await GameLogics[game.slug].excuteMove(match, movement)
      callback(success);
      if (success) {
        io.to(`room:${match.room_id}`).emit('room:player-action', data);
        if (gameover) {
          await roomService.gameover(match.room_id, match_id, movement.player_id)
          io.to(`room:${match.room_id}`).emit('room:game-over', pick(player, ['_id', 'nickname']))
        } else if (data.next_turn) {
          const next = await MPlayer.findById(data.next_turn, { type: 1 }).lean(true)
          if (next?.type === PlayerType.robot) {
            const robot = robots.getRobot(next._id, game.slug);
            if (robot) {
              const move = robot.getBestMove(board, data.point.color === 'black' ? 1 : 2);
              if (move) {
                const new_match = await MMatch.findOne({ _id: match_id }).lean(true);
                const result = await GameLogics[game.slug].excuteMove(new_match, { player_id: next._id, point: { x: move.x - 7, y: move.y - 7, color: data.point.color === 'black' ? 'white' : 'black' } })
                if (result.success) {
                  io.to(`room:${match.room_id}`).emit('room:player-action', result.data);
                }
                if (result.gameover) {
                  await roomService.gameover(match.room_id, match_id, next._id)
                  io.to(`room:${match.room_id}`).emit('room:game-over', pick(next, ['_id', 'nickname']))
                }
              }
            }
          }
        }
      }
    } else {
      callback(false)
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
    if (!room || room.status !== RoomStatus.playing) {
      callback(false);
      return;
    }
    const player = await MPlayer.findById(data.player_id).lean(true);
    if (!player || player.user_id !== user_id) {
      callback(false);
      return;
    }
    try {
      callback(true);
      console.log(`🏡 ${room._id} 👤 玩家 ${player._id} 认输`);
      const winner_id = room.members.filter(m => !m.watch_id).map(m => m._id).find(_id => _id !== data.player_id)
      await roomService.gameover(data.room_id, data.match_id, winner_id as string)
      const winner = await MPlayer.findById(winner_id).lean(true)
      io.to(`room:${data.room_id}`).emit('room:game-over', pick(winner, ['_id', 'nickname']))
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
      const player = await MPlayer.findById(data.player_id).lean(true)
      io.to(`room:${data.room_id}`).emit('room:player-leaved', pick(player, ['_id', 'nickname']));
      console.log(`👤 玩家 ${data.player_id} 离开房间 ${data.room_id}`);
      players.forEach(p => {
        io.to(`user:${user_id}`).emit('room:player-change', p);
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
      io.to(`room:${room._id}`).emit('lobby:room-destroyed', {});
      cb(true);
    } else {
      cb(false);
    }
  }
}