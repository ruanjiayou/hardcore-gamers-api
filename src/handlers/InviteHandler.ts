/**
 * 房间内邀请好友。
 *
 * 取代原来悬空的 `lobby:join-invite-room`（前端有事件常量、服务端没有 handler）：
 * - 房内玩家按**用户名**邀请一位用户 → 服务端把邀请推到对方 `user:${id}` 频道；
 * - 对方界面上右上角常驻提示，点接受/拒绝后邀请才消失（服务端 Map 里同时删除）；
 * - 接受后服务端代为入房（自动建该游戏的 player、退出旧房间、加入新房间），
 *   并广播 `room:player-joined`，回执 `invite:accepted` 让前端跳到该房间。
 */
import type { Server } from 'socket.io';
import { v7 } from 'uuid';
import { MGame, MPlayer, MRoom, MUser } from '../models';
import { playerService } from '../services/PlayerService';
import { roomService } from '../services/RoomService';
import { snakeRuntimeService } from '../services/SnakeRuntimeService';
import type { AuthSocket } from '../middleware/auth';
import constant from '../constant';

/** 邀请有效期：2 分钟不处理即失效（避免下线后留下永不过期的邀请） */
const INVITE_TTL_MS = 2 * 60 * 1000;

interface PendingInvite {
  id: string;
  room_id: string;
  game_id: string;
  slug: string;
  room_name: string;
  from_user_id: string;
  to_user_id: string;
  created_at: number;
}

const pending = new Map<string, PendingInvite>();

function prune() {
  const now = Date.now();
  for (const [id, inv] of pending) {
    if (now - inv.created_at > INVITE_TTL_MS) pending.delete(id);
  }
}

export function setupInviteHandlers(io: Server, socket: AuthSocket, user_id: string) {
  socket.on('room:invite', sendInvite);
  socket.on('invite:respond', respondInvite);

  async function sendInvite(data: { room_id: string; target: string }, cb?: (ok: boolean, message?: string) => void) {
    if (!socket.isLoggedIn || !user_id) return cb?.(false, '请先登录');
    const target = String(data?.target || '').trim();
    if (!target) return cb?.(false, '请输入对方用户名');

    const room = await MRoom.findById(data.room_id).lean(true);
    if (!room) return cb?.(false, '房间不存在');
    if (room.transient) return cb?.(false, '单人房间不能邀请');

    const me = await MPlayer.findOne({ user_id, game_id: room.game_id }).lean(true);
    if (!me || !room.members.some(m => m._id === me._id)) return cb?.(false, '你不在这个房间里');

    // 支持按登录名或 user_id 邀请（没有好友关系表，用户名就是唯一的"好友入口"）
    const targetUser = await MUser.findOne(
      { $or: [{ name: target }, { _id: target }] },
      { name: 1, nickname: 1, avatar: 1 },
    ).lean(true) as any;
    if (!targetUser) return cb?.(false, '用户不存在');
    if (targetUser._id === user_id) return cb?.(false, '不能邀请自己');

    const targetPlayer = await MPlayer.findOne({ user_id: targetUser._id, game_id: room.game_id }, { _id: 1 }).lean(true) as any;
    if (targetPlayer && room.members.some(m => m._id === targetPlayer._id)) return cb?.(false, '对方已在房间中');

    const game = await MGame.findById(room.game_id, { slug: 1, title: 1 }).lean(true) as any;
    prune();
    // 同一房间对同一人只保留最新一条
    for (const [id, inv] of pending) {
      if (inv.to_user_id === targetUser._id && inv.room_id === room._id) pending.delete(id);
    }

    const invite: PendingInvite = {
      id: v7(),
      room_id: room._id,
      game_id: room.game_id,
      slug: game?.slug || '',
      room_name: room.name,
      from_user_id: user_id,
      to_user_id: targetUser._id,
      created_at: Date.now(),
    };
    pending.set(invite.id, invite);

    io.to(`user:${targetUser._id}`).emit('invite:received', {
      invite_id: invite.id,
      room_id: invite.room_id,
      slug: invite.slug,
      game_title: game?.title || invite.slug,
      room_name: invite.room_name,
      from: {
        user_id,
        nickname: me.nickname || '玩家',
        avatar: me.avatar || '',
      },
      expires_at: invite.created_at + INVITE_TTL_MS,
    });
    console.log(`✉️ ${me.nickname || user_id} 邀请 ${targetUser.name} 进入房间 ${room._id}`);
    cb?.(true, '邀请已发送');
  }

  async function respondInvite(data: { invite_id: string; accept: boolean }, cb?: (ok: boolean, message?: string) => void) {
    if (!socket.isLoggedIn || !user_id) return cb?.(false, '请先登录');
    const invite = pending.get(data?.invite_id);
    if (!invite || invite.to_user_id !== user_id) return cb?.(false, '邀请已失效');

    // 点接受或拒绝后邀请就消失（先删，后续失败也不再重复提示）
    pending.delete(invite.id);
    const base = { invite_id: invite.id, room_id: invite.room_id, slug: invite.slug };

    const fail = (message: string) => {
      io.to(`user:${invite.from_user_id}`).emit('invite:result', { ...base, accepted: false, message });
      cb?.(false, message);
    };

    if (!data.accept) {
      io.to(`user:${invite.from_user_id}`).emit('invite:result', { ...base, accepted: false, message: '对方拒绝' });
      return cb?.(true, '已拒绝邀请');
    }

    const room = await MRoom.findById(invite.room_id).lean(true) as any;
    if (!room || room.status === constant.ROOM.STATUS.deleted) return fail('房间已解散');

    const player = await playerService.getOrCreatePlayer(user_id, invite.slug);
    if (!player) return fail('玩家不存在');
    // 还挂在别的房间：先退出（对局进行中会失败，给出服务端原因）
    if (player.room_id && player.room_id !== room._id) {
      const left = await roomService.leaveRoom(player.room_id, player._id);
      if (!left.ok) return fail(left.reason || '请先离开当前房间');
    }

    const joined = await roomService.joinRoom({ room_id: room._id, type: constant.MEMBER.TYPE.player }, player);
    if (!joined.success) return fail(joined.reason || '加入房间失败');

    // 把该用户的所有 socket 拉进房间频道，否则收不到房间广播
    io.in(`user:${user_id}`).socketsJoin(`room:${room._id}`);
    io.to(`room:${room._id}`).emit('room:player-joined', { ...player, ...joined.newPlayer });

    // 无尽竞技房是常驻对局：补开局通知并把新玩家放进当前对局
    if (room.settings?.variant === 'endless') {
      const arena = await roomService.ensureSnakeArena(room._id);
      if (arena.match_id) {
        if (room.status === constant.ROOM.STATUS.playing) {
          await snakeRuntimeService.addPlayer(arena.match_id, player._id, (player as any).nickname);
        }
        io.to(`room:${room._id}`).emit('room:game-start', { room_id: room._id, match_id: arena.match_id, timestamp: Date.now() });
      }
    }

    io.to(`user:${user_id}`).emit('invite:accepted', { room_id: room._id, slug: invite.slug });
    io.to(`user:${invite.from_user_id}`).emit('invite:result', {
      ...base,
      accepted: true,
      nickname: (player as any).nickname || '玩家',
    });
    console.log(`✉️✅ ${user_id} 接受邀请进入房间 ${room._id}`);
    cb?.(true, '已加入房间');
  }
}
