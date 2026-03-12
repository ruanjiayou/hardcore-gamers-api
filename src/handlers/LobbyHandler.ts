/**
 * 大厅事件处理 - 支持密码加入和房间自动解散
 */

import type { Server } from 'socket.io';
import { gameService } from '../services/GameService';
import { roomService } from '../services/RoomService';
import { playerService } from '../services/PlayerService';
import type { AuthSocket } from '../middleware/auth';
import { userService } from '../services/UserService';
import { IPlayer, CB, IMember } from '../types';
import { MPlayer, MRoom } from '../models';
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
  async function getRooms(where: { game_id: string }, cb: CB) {
    const rooms = await roomService.getRoomsByGameId(where.game_id);
    cb && cb(rooms);
  }

  async function getGamePlayer(name: string, cb: CB) {
    const player = await playerService.getOrCreatePlayer(user_id, name);
    if (player.room_id) {
      const room = await MRoom.findById(player.room_id).lean(true);
      const member = room?.members.find(m => m._id === player._id);
      cb({ ...player, ...member })
    } else {
      cb(player);
    }
  }
  async function createRoom(data: { slug: string; name: string; isPrivate?: boolean; password?: string }, cb: CB) {
    if (!isLoggedIn) {
      cb(false, undefined, '创建房间需要登陆');
      return;
    }
    const { name, slug, isPrivate, password } = data;
    const player = await playerService.getOrCreatePlayer(user_id, slug);

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
  async function joinRoom(data: { room_id: string; watch_id: string, password?: string }, cb: CB) {
    if (!cb) {
      return;
    }
    if (!isLoggedIn) {
      cb(false, '加入房间需要登陆');
      return;
    }

    const room = await MRoom.findById(data.room_id).lean(true);
    const player = await MPlayer.findOne({ user_id, game_id: room?.game_id }).lean(true);
    if (!player) {
      return cb(false, '玩家不存在')
    }
    try {
      const result = await roomService.joinRoom(data.room_id, data.watch_id, player, data.password);
      if (!result.success) {
        cb(false, '加入房间失败');
        return;
      }
      // 处理页面刷新 信息丢失
      socket.room_id = data.room_id;
      socket.player_id = player._id;
      socket.join(`room:${data.room_id}`);
      await MPlayer.updateOne({ _id: player._id }, { $set: { state: constant.PLAYER.STATE.inroom } })
      cb(true, { ...player, ...result.newPlayer });
      io.to(`room:${data.room_id}`).emit('room:player-joined', player);
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
  async function getLeaderboard(data: { slug: string, limit?: number }, cb: CB) {
    if (!cb) {
      return;
    }
    const limit = data.limit || 5;
    const leaderboard = (await playerService.getLeaderboard(data.slug, limit)).map((item, index) => ({
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