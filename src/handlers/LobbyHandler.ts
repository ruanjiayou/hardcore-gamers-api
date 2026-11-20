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
import { snakeRuntimeService } from '../services/SnakeRuntimeService';
import constant, { MemberType } from '../constant';
import { isSoloGame } from '../utils/gameMode';

export function setupLobbyHandlers(io: Server, socket: AuthSocket, user_id: string) {
  const isLoggedIn = socket.isLoggedIn;
  const isGuest = socket.isGuest;

  socket.on('lobby:get-games', getGames);
  socket.on('lobby:get-rooms', getRooms);
  socket.on('lobby:create-room', createRoom);
  socket.on('lobby:join-room', joinRoom);
  socket.on('lobby:quick-start', quickStart);
  socket.on('lobby:match', matchRoom);
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
    // 游客没有 player，不能按空 user_id 建号
    if (!isLoggedIn || !user_id) {
      cb && cb(null);
      return;
    }
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
    data: { slug: string; name: string; isPrivate?: boolean; password?: string; allowSpectate?: boolean; variant?: string },
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

    // 玩法变体：客户端指定的房间玩法优先，未指定则取第一个房间玩法
    const variant = data.variant
      ? game.variants?.find(v => v.key === data.variant && v.mode === 'room')
      : (game.variants?.find(v => v.mode === 'room') || game.variants?.[0]);

    try {
      const room = await roomService.createRoomWithOwner({
        game_id: game._id,
        name: data.name,
        owner_id: player._id,
        members: [],
        numbers: variant?.numbers || game.numbers,
        isPrivate: isPrivate || false,
        password: isPrivate ? password : undefined,
        // 观战开关：默认允许观战，房主可在开局前关闭
        allowSpectate: data.allowSpectate !== false,
        // 官方房只由种子预建；临时房只由 quick-start 创建——客户端传入一律忽略
        official: false,
        transient: false,
        settings: {
          difficulty: 'normal',
          mode: 'casual',
          // 混合玩法游戏（贪吃蛇）：自建/官方房都走房间玩法变体，用于判定规则与分榜
          ...(variant ? { variant: variant.key } : {}),
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

      // 无尽挑战（官方竞技房）：进房即开局；已在局中的直接把自己那条蛇加进去
      if (room.settings?.variant === 'endless') {
        const isPlayer = data.type === constant.MEMBER.TYPE.player;
        if (isPlayer) await enterEndlessArena(room, player._id, player.nickname);
      }
    } catch (error) {
      cb(false, '加入房间失败');
    }
  }

  /**
   * 匹配：不再给玩家看房间列表，直接找一张"还有空位"的桌子进去。
   * - 优先把已经有人但没坐满的桌子填满（体感上真的在匹配，而不是永远开新房）；
   * - 一张空位都没有时，替你开一张新房等着（等同建房，玩家不用自己起名）；
   * - 无尽挑战是常驻竞技房，开局后也能进，所以不看房间状态。
   */
  async function matchRoom(data: { slug: string; variant?: string }, cb: CB) {
    if (!cb) return;
    if (!isLoggedIn) return cb(false, undefined, '匹配需要登陆');

    const game = await gameService.getGameBySlug(data.slug);
    if (!game) return cb(false, undefined, '游戏不存在');

    const variants = game.variants || [];
    const variant = data.variant
      ? variants.find(v => v.key === data.variant)
      : (variants.find(v => v.mode === 'room') || variants[0]);
    if (data.variant && !variant) return cb(false, undefined, '该玩法不存在');

    const player = await playerService.getOrCreatePlayer(user_id, data.slug);
    if (!player) return cb(false, undefined, '玩家不存在');

    // 匹配语义是"给我找张能打的桌子"：还挂在旧房间里就先退出
    if (player.room_id) {
      const left = await roomService.leaveRoom(player.room_id, player._id);
      if (!left.ok) return cb(false, undefined, left.reason || '请先离开当前房间');
    }

    const variantKey = variant?.key || '';
    const endlessArena = variantKey === 'endless';
    const playerCount = (room: any) =>
      (room.members || []).filter((m: any) => m.member_type === constant.MEMBER.TYPE.player).length;

    try {
      const rooms = await MRoom.find({
        game_id: game._id,
        isPrivate: false,
        transient: false,
        status: { $ne: constant.ROOM.STATUS.deleted },
      }).lean(true);

      const candidates = rooms
        // 只看同一玩法：无尽桌和多人桌不能混着匹配
        .filter((r: any) => (r.settings?.variant || '') === variantKey)
        .filter((r: any) => playerCount(r) < r.numbers.max)
        .filter((r: any) => endlessArena || r.status === constant.ROOM.STATUS.waiting)
        .sort((a: any, b: any) => {
          const diff = playerCount(b) - playerCount(a);
          if (diff) return diff;
          // 人数一样时优先官方桌
          return (a.official === b.official) ? 0 : (a.official ? -1 : 1);
        });

      let room: any = candidates[0];
      let member: any = null;

      if (room) {
        const result = await roomService.joinRoom({ room_id: room._id, type: constant.MEMBER.TYPE.player }, player);
        if (!result.success) return cb(false, undefined, result.reason || '匹配失败');
        member = { ...player, ...result.newPlayer };
      } else {
        room = await roomService.createRoomWithOwner({
          game_id: game._id,
          name: `${player.nickname || '玩家'} 的房间`,
          owner_id: player._id,
          members: [],
          numbers: variant?.numbers || game.numbers,
          isPrivate: false,
          allowSpectate: true,
          official: false,
          transient: false,
          settings: {
            difficulty: 'normal',
            mode: 'casual',
            ...(variant ? { variant: variant.key } : {}),
          },
        }, player);
        // 与 joinRoom 一致，回传带 member_type 的成员记录（房间页据此判断身份）
        const fresh = await MRoom.findById(room._id).lean(true);
        const self = fresh?.members.find((m: any) => m._id === player._id);
        member = { ...player, ...self };
      }

      socket.room_id = room._id;
      socket.player_id = player._id;
      socket.join(`room:${room._id}`);
      // 前端只关心"匹配到哪张桌子"，room_id 必须显式回传（member 记录本身不带 room_id）
      cb(true, { ...member, room_id: room._id });
      io.to(`room:${room._id}`).emit('room:player-joined', member);

      if (endlessArena) await enterEndlessArena(room, player._id, player.nickname);
      console.log(`🎯 匹配成功: ${game.slug}/${variantKey} → ${room._id}（${room.official ? '官方桌' : '新桌'}）`);
    } catch (error) {
      console.log('❌ 匹配失败:', error);
      cb(false, undefined, '匹配失败，请重试');
    }
  }

  /**
   * 无尽竞技房：没有"开始游戏"按钮，进房即开局。
   * - 房间还在等待 / 房间停在 playing 但对局已不存在：统一交给 ensureSnakeArena
   *   （它会自愈幽灵状态、必要时重新开局、并在运行时丢失时按库里局面重建）；
   * - 已经在局中（有人先到了）：除了重建运行时，还要把新玩家那条蛇放进当前对局。
   */
  async function enterEndlessArena(room: any, player_id: string, nickname?: string) {
    try {
      const before = await MRoom.findById(room._id, { status: 1 }).lean(true) as any;
      const arena = await roomService.ensureSnakeArena(room._id);
      if (!arena.match_id) return;
      const payload = { room_id: room._id, timestamp: Date.now() };
      // 已经是进行中的对局：把刚进来的玩家加进去（开局时才建的局已包含他）
      if (!arena.started && before?.status === constant.ROOM.STATUS.playing) {
        snakeRuntimeService.addPlayer(arena.match_id, player_id, nickname);
      }
      io.to(`room:${room._id}`).emit('room:game-start', { ...payload, match_id: arena.match_id });
    } catch (error) {
      console.log('❌ 无尽竞技房开局失败:', error);
    }
  }

  /**
   * 单人快开：一键开一局，不进房间列表。
   * - 纯单人游戏（2048/俄罗斯方块）：直接按 game.numbers 建临时房
   * - 混合玩法游戏（贪吃蛇）：需指定 variant（endless），用该玩法的人数与分榜
   * 创建临时房（transient）→ 立即开局 → 把 room_id/match_id 交还前端进对局页。
   * 临时房不对外人开放、离开即销毁；分数由对局内实时上报（$max 最高分）。
   */
  async function quickStart(data: { slug: string; variant?: string }, cb: CB) {
    if (!isLoggedIn) {
      cb(false, undefined, '开始游戏需要登录');
      return;
    }
    const game = await gameService.getGameBySlug(data.slug);
    if (!game) {
      cb(false, undefined, '游戏不存在');
      return;
    }

    const variants = game.variants || [];
    // 指定了 variant 就按变体校验；未指定则取该游戏的单人选玩变体（纯单人游戏没有变体）
    const variant = data.variant
      ? variants.find(v => v.key === data.variant)
      : variants.find(v => v.mode === 'solo');

    if (data.variant && !variant) {
      cb(false, undefined, '该玩法不存在');
      return;
    }
    if (variant) {
      if (variant.mode !== 'solo') {
        cb(false, undefined, '该玩法为房间对战，请创建或加入房间');
        return;
      }
    } else if (!isSoloGame(game)) {
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

      // 单人玩法一律 1 人房；房间制变体的人数下限不适用于快开
      const numbers = variant?.numbers ?? (variant ? { min: 1, max: 1 } : game.numbers);

      const room = await roomService.createRoomWithOwner({
        game_id: game._id,
        name: `${player.nickname || '玩家'} 的${variant?.label || '单人'}局`,
        owner_id: player._id,
        members: [],
        numbers,
        isPrivate: false,
        // 临时房：不进房间列表/计数，离开即销毁
        transient: true,
        allowSpectate: false,
        // variant 决定玩法与分榜（贪吃蛇：endless）
        settings: { ...(variant ? { variant: variant.key } : {}) },
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
  async function getLeaderboard(data: { slug: string, limit?: number, board?: string }, cb: CB) {
    if (!cb) {
      return;
    }
    const limit = data.limit || 5;
    const leaderboard = (await playerService.getLeaderboard(data.slug, limit, data.board)).map((item, index) => ({
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