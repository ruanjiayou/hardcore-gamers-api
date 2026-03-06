/**
 * 大厅事件处理 - 支持密码加入和房间自动解散
 */

import type { Server } from 'socket.io';
import { gameService } from '../services/GameService';
import { roomService } from '../services/RoomService';
import { playerService } from '../services/PlayerService';
import type { AuthSocket } from '../middleware/auth';
import { userService } from '../services/UserService';
import { IPlayer, CB } from '../types';
import { MRoom } from '../models';
import constant from '../constant';

export function setupLobbyHandlers(io: Server, socket: AuthSocket, user_id: string) {
  const isLoggedIn = socket.isLoggedIn;
  const isGuest = socket.isGuest;

  socket.on('lobby:get-games', getGames);
  socket.on('lobby:get-rooms', getRooms);
  socket.on('lobby:create-room', createRoom);
  socket.on('lobby:join-room', joinRoom);
  socket.on('lobby:get-user-info', getUserInfo);
  socket.on('lobby:get-leaderboard', getLeaderboard);
  socket.on('lobby:get-stats', getStats);

  socket.on('lobby:get-game-player', getGamePlayer);

  async function getGames(cb: CB) {
    const games = await gameService.getAllGames(true);
    cb && cb(games);
  }
  async function getRooms(where: { slug: string }, cb: CB) {
    const rooms = await roomService.getRoomsByGameName(where.slug);
    cb && cb(rooms);
  }
  async function getGamePlayer(where: { slug: string }, cb: CB) {
    const player = await playerService.getOrCreatePlayer(user_id, where.slug);
    if (player.room_id) {
      const room = await roomService.getRoomById(player.room_id);
      const roomPlayer = room?.members.find(p => p._id === player._id)
      cb({ ...roomPlayer, room_id: player.room_id });
    } else {
      cb(player);
    }
  }
  async function createRoom(data: { room_id: string; name: string; isPrivate?: boolean; password?: string }, cb: CB) {
    if (!isLoggedIn) {
      cb(false, undefined, '创建房间需要登陆');
      return;
    }

    const { name, isPrivate, password } = data;
    const player = await playerService.getOrCreatePlayer(user_id, name);

    if (!player) {
      cb(false, undefined, '玩家不存在');
      return;
    }

    const game = await gameService.getGameById(player.game_id);
    if (!game) {
      cb(false, undefined, '游戏不存在');
      return;
    }

    // 验证密码
    if (isPrivate && !password) {
      cb(false, undefined, '私密房间必须设置密码');
      return;
    }

    try {
      const room = await roomService.createRoom({
        game_id: game._id,
        name: data.name,
        owner_id: player.user_id,
        members: [],
        numbers: game.numbers,
        isPrivate: isPrivate || false,
        password: isPrivate ? password : undefined,
        settings: {
          difficulty: 'normal',
          mode: 'casual'
        }
      });

      cb(true, room._id);
      console.log(`✨ 房间创建: ${room._id} (玩家: ${player.user_id})`);
    } catch (error) {
      console.log(error)
      cb(false, undefined, '创建房间失败');
    }
  }
  async function joinRoom(data: { room_id: string; type: 'player' | 'viewer', password?: string }, cb: CB) {
    if (!cb) {
      return;
    }
    if (!isLoggedIn) {
      cb(false, '加入房间需要登陆');
      return;
    }

    const { room_id, password } = data;
    const room = await roomService.getRoomById(room_id);
    if (!room) {
      cb(false, '房间不存在');
      return;
    }
    let inroom = false;
    const players = room.members.filter(m => m.type === constant.MEMBER.TYPE.player);
    if (players.findIndex(p => p.user_id === socket.user_id) !== -1) {
      inroom = true
    } else if (players.length >= room.numbers.max) {
      cb(false, '房间已满');
      return;
    }

    let player: IPlayer | null = null;
    try {
      player = await playerService.getOrCreatePlayer(user_id, room.game_id);
    } catch (err: any) {
      console.log('获取用户错误', err.message)
    }

    if (!player) {
      cb(false, '玩家不存在');
      return;
    }

    // 检查房间状态
    if (data.type === 'player') {
      // @ts-ignore
      if (players.findIndex(p => p._id === player._id) === -1 && (room.status === 'playing' || room.status === 'loading')) {
        cb(false, '游戏已开始，无法加入');
        return;
      }
    }

    try {
      let newPlayer: IPlayer | null = null;
      if (!inroom) {
        const result = await roomService.joinRoom(room_id, data.type, player, password);
        if (!result.success) {
          cb(false, room.isPrivate ? '房间密码错误' : '加入房间失败');
          return;
        } else if (result.newPlayer) {
          newPlayer = result.newPlayer;
        }
      }
      // 处理页面刷新 信息丢失
      socket.room_id = room_id;
      socket.player_id = player._id;
      socket.join(`room:${room_id}`);

      cb(true, newPlayer);
      io.to(`room:${room_id}`).emit('room:player-joined', player);
      console.log(`👤 玩家 ${player.user_id} 加入房间 ${room_id}`);
    } catch (error) {
      cb(false, '加入房间失败');
    }
  }
  async function getUserInfo(cb: CB) {
    if (!isLoggedIn || !socket.user_id) {
      cb(null);
      return;
    }

    const userInfo = await userService.getInfoById(socket.user_id);
    cb(userInfo);
  }
  async function getLeaderboard(data: { limit?: number }, cb: CB) {
    if (!cb) {
      return;
    }
    const limit = data.limit || 10;
    const leaderboard = (await playerService.getLeaderboard(limit)).map((item, index) => ({
      ...item,
      rank: index + 1
    }));

    cb(leaderboard);
  }
  async function getStats(cb: CB) {
    const games = await gameService.getStats();
    const rooms = await roomService.getStats();
    const users = await userService.getStats();
    const players = await playerService.getStats()
    const stats = {
      games,
      rooms,
      users,
      players
    };
    cb(stats);
  }

}