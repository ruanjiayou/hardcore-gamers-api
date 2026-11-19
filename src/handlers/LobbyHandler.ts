/**
 * 大厅事件处理 - 支持密码加入和房间自动解散
 */

import type { Server } from 'socket.io';
import { gameService } from '../services/GameService';
import { roomService } from '../services/RoomService';
import { playerService } from '../services/PlayerService';
import type { AuthSocket } from '../middleware/auth';
import { userService } from '../services/UserService';
import { CB } from '../types';
import { MPlayer, MRoom } from '../models';
import constant, { MemberType } from '../constant';

export function setupLobbyHandlers(io: Server, socket: AuthSocket, user_id: string) {
  const isLoggedIn = socket.isLoggedIn;
  const isGuest = socket.isGuest;

  socket.on('lobby:get-games', getGames);
  socket.on('lobby:get-rooms', getRooms);
  socket.on('lobby:create-room', createRoom);
  socket.on('lobby:join-room', joinRoom);
  socket.on('lobby:quick-start', quickStart);
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
      const room_key = `room:${player.room_id}`
      // 重连路径也要同步 socket.room_id/player_id，否则断线广播拿不到房间号
      socket.room_id = player.room_id;
      socket.player_id = player._id;
      if (!socket.rooms.has(room_key)) {
        socket.join(room_key);
        io.to(room_key).emit('room:player-rejoined', player)
      }
    } else {
      cb(player);
    }
  }
  async function createRoom(
    data: { slug: string; name: string; isPrivate?: boolean; password?: string; allowSpectate?: boolean },
    cb: CB,
  ) {
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
      const room = await roomService.createRoomWithOwner({
        game_id: game._id,
        name: data.name,
        owner_id: player._id,
        members: [],
        numbers: game.numbers,
        isPrivate: isPrivate || false,
        password: isPrivate ? password : undefined,
        // 观战开关：默认允许观战，房主可在开局前关闭
        allowSpectate: data.allowSpectate !== false,
        // 官方房只由种子预建；临时房只由 quick-start 创建——客户端传入一律忽略
        official: false,
        transient: false,
        settings: {
          difficulty: 'normal',
          mode: 'casual'
        }
      }, player);

      // 同步 socket 的房间归属，保证断线广播/重连能定位到该房间
      socket.room_id = room._id;
      socket.player_id = player._id;
      socket.join(`room:${room._id}`);
      cb(true, room._id);
      console.log(`✨ 房间创建: ${room._id} (玩家: ${player.user_id})`);
    } catch (error) {
      console.log(error)
      cb(false, undefined, '创建房间失败');
    }
  }
  async function joinRoom(data: { room_id: string; type: MemberType, password?: string }, cb: CB) {
    if (!cb) {
      return;
    }
    if (!isLoggedIn) {
      cb(false, '加入房间需要登陆');
      return;
    }

    const room = await MRoom.findById(data.room_id).lean(true);
    if (!room) {
      return cb(false, '房间不存在')
    }
    const player = await MPlayer.findOne({ user_id, game_id: room.game_id }).lean(true);
    if (!player) {
      return cb(false, '玩家不存在')
    }
    try {
      const result = await roomService.joinRoom(data, player);
      if (!result.success) {
        cb(false, result.reason || '加入房间失败');
        return;
      }
      // 处理页面刷新 信息丢失（玩家 state/room_id 已由 RoomService.joinRoom 统一落库）
      socket.room_id = data.room_id;
      socket.player_id = player._id;
      socket.join(`room:${data.room_id}`);
      const joinedMember = { ...player, ...result.newPlayer };
      cb(true, joinedMember);
      // 广播带上 member 字段，前端据此正确过滤 player/viewer
      io.to(`room:${data.room_id}`).emit('room:player-joined', joinedMember);
    } catch (error) {
      cb(false, '加入房间失败');
    }
  }

  /**
   * 单人游戏快开：一键开一局，不进房间列表。
   * 创建临时房（transient）→ 立即开局 → 把 room_id/match_id 交还前端进对局页。
   * 临时房不对外人开放、离开即销毁；分数由对局内实时上报（$max 最高分）。
   */
  async function quickStart(data: { slug: string }, cb: CB) {
    if (!isLoggedIn) {
      cb(false, undefined, '开始游戏需要登录');
      return;
    }
    const game = await gameService.getGameBySlug(data.slug);
    if (!game) {
      cb(false, undefined, '游戏不存在');
      return;
    }
    if (game.mode !== 'solo') {
      cb(false, undefined, '该游戏为房间对战模式，请创建或加入房间');
      return;
    }
    const player = await playerService.getOrCreatePlayer(user_id, data.slug);
    if (!player) {
      cb(false, undefined, '玩家不存在');
      return;
    }

    try {
      // 若还挂在上一局临时房里（如中途退出重进），先离开；临时房离开即销毁
      if (player.room_id) {
        const left = await roomService.leaveRoom(player.room_id, player._id);
        if (!left.ok) {
          return cb(false, undefined, left.reason || '请先离开当前房间');
        }
      }

      const room = await roomService.createRoomWithOwner({
        game_id: game._id,
        name: `${player.nickname || '玩家'} 的单人局`,
        owner_id: player._id,
        members: [],
        numbers: game.numbers,
        isPrivate: false,
        // 临时房：不进房间列表/计数，离开即销毁
        transient: true,
        allowSpectate: false,
        settings: {},
      }, player);

      // 同步 socket 的房间归属，保证断线广播/重连能定位到该房间
      socket.room_id = room._id;
      socket.player_id = player._id;
      socket.join(`room:${room._id}`);

      const match_id = await roomService.startGame(room._id);
      if (!match_id) {
        await roomService.destroyRoom(room._id);
        return cb(false, undefined, '开局失败');
      }

      cb(true, { room_id: room._id, match_id });
      const payload = { room_id: room._id, match_id, timestamp: Date.now() };
      io.to(`room:${room._id}`).emit('room:game-start', payload);
      console.log(`⚡ 单人快开: ${game.slug} room=${room._id} match=${match_id}`);
    } catch (error) {
      console.log(error);
      cb(false, undefined, '开局失败');
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