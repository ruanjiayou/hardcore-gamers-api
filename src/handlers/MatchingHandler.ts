/**
 * 匹配事件处理 - 支持权限检查
 */

import type { Server } from 'socket.io';
import { matchingService } from '../services/MatchingService';
import { playerService } from '../services/PlayerService';
import { roomService } from '../services/RoomService';
import type { IPlayer, MatchingMode } from '../types/index';
import type { AuthSocket } from '../middleware/auth';
import constant from '../constant';

export function setupMatchingHandlers(io: Server, socket: AuthSocket, user_id: string) {
  /**
   * 加入匹配队列 - 需要登陆
   */
  socket.on(
    'matching:join-queue',
    async (data: { game_id: string; mode: MatchingMode }, callback: (success: boolean, error?: string) => void) => {
      if (!socket.isLoggedIn) {
        callback(false, '加入匹配需要登陆');
        console.log(`❌ 游客 ${socket.user_id} 尝试加入匹配被拒绝`);
        return;
      }

      const { game_id, mode } = data;
      // 连接阶段只有 user_id，按 (user_id, game_id) 解析出该游戏的 player
      const player = await playerService.getOrCreatePlayer(user_id, game_id);

      if (!player) {
        callback(false, '玩家不存在');
        return;
      }
      const player_id = player._id;

      try {
        matchingService.addToQueue({
          player_id,
          game_id,
          mode,
          createdAt: Date.now()
        });

        await playerService.updatePlayerStatus(player_id, constant.PLAYER.STATE.matching);

        socket.emit('matching:joined-queue', {
          game_id,
          mode,
          queueInfo: matchingService.getQueueInfo(game_id)
        });

        callback(true);
        console.log(`📍 玩家 ${player.user_id} 加入匹配队列 (游戏: ${game_id}, 模式: ${mode})`);

        _tryMatching(io, game_id, player_id);
      } catch (error) {
        callback(false, '加入匹配失败');
      }
    }
  );

  /**
   * 取消匹配 - 需要登陆
   */
  socket.on(
    'matching:leave-queue',
    async (data: { game_id: string }, callback: (success: boolean) => void) => {
      if (!socket.isLoggedIn) {
        callback(false);
        return;
      }

      const { game_id } = data;

      try {
        const player = await playerService.getOrCreatePlayer(user_id, game_id);
        if (player) {
          matchingService.removeFromQueue(game_id, player._id);
          await playerService.updatePlayerStatus(player._id, constant.PLAYER.STATE.online);
        }
        socket.emit('matching:left-queue', { game_id });
        callback(true);
        console.log(`🚫 玩家 ${socket.user_id} 取消匹配 (游戏: ${game_id})`);
      } catch (error) {
        callback(false);
      }
    }
  );

  /**
   * 获取匹配队列信息 - 公开
   */
  socket.on('matching:get-queue-info', (data: { game_id: string }, callback: (queueInfo: any) => void) => {
    const queueInfo = matchingService.getQueueInfo(data.game_id);
    callback(queueInfo);
  });
}

/**
 * 尝试进行匹配
 */
function _tryMatching(io: Server, game_id: string, player_id: string) {
  setTimeout(async () => {
    const matched = matchingService.findMatch(game_id, 2);

    if (!matched) return;
    console.log(`✅ 匹配成功: ${matched.length} 个玩家`);
    const players: IPlayer[] = (await Promise.all(
      matched.map(req => playerService.getPlayerById(req.player_id))
    )).filter((v): v is IPlayer => Boolean(v));

    if (players.length < 2) return;
    const owner = players[0];
    const room = await roomService.createRoom({
      game_id,
      name: `Ranked Match - ${Date.now()}`,
      // 全项目统一以 player._id 作为 owner_id（member._id 也是 player_id）
      owner_id: owner._id,
      members: [],
      numbers: { min: 2, max: Math.min(2, players.length) },
      isPrivate: false,
      settings: { mode: 'ranked' }
    });

    // 房主与其余玩家都要入房；joinRoom 已统一同步 MPlayer 的 state/room_id
    for (const p of players) {
      await roomService.joinRoom(
        { room_id: room._id as string, type: constant.MEMBER.TYPE.player },
        p
      );
    }

    // 通知发到用户专属房间 user:${user_id}
    matched.forEach(req => {
      const p = players.find(v => v._id === req.player_id);
      if (!p) return;
      io.to(`user:${p.user_id}`).emit('matching:matched', {
        room_id: room._id,
        opponents: players
          .filter(v => v._id !== req.player_id)
          .map(v => ({ _id: v._id, nickname: v.nickname, level: v.level, avatar: v.avatar }))
      });
    });
  }, 1000);
}