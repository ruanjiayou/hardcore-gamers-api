/**
 * 匹配事件处理 - 支持权限检查
 */

import type { Server, Socket } from 'socket.io';
import { matchingService } from '../services/MatchingService';
import { playerService } from '../services/PlayerService';
import { roomService } from '../services/RoomService';
import type { IPlayer, MatchingMode } from '../types/index';
import type { AuthSocket } from '../middleware/auth';

export function setupMatchingHandlers(io: Server, socket: AuthSocket, player_id: string) {
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
      const player = await playerService.getPlayerById(player_id);

      if (!player) {
        callback(false, '玩家不存在');
        return;
      }

      try {
        matchingService.addToQueue({
          player_id,
          game_id,
          mode,
          createdAt: Date.now()
        });

        playerService.updatePlayerStatus(player_id, 'in-lobby');

        socket.emit('matching:joined-queue', {
          game_id,
          mode,
          queueInfo: matchingService.getQueueInfo(game_id)
        });

        callback(true);
        console.log(`📍 玩家 ${player.user_id} 加入匹配队列 (游戏: ${game_id}, 模式: ${mode})`);

        _tryMatching(io, game_id, player._id);
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
    (data: { game_id: string }, callback: (success: boolean) => void) => {
      if (!socket.isLoggedIn) {
        callback(false);
        return;
      }

      const { game_id } = data;

      try {
        matchingService.removeFromQueue(game_id, player_id);
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

    if (matched) {
      console.log(`✅ 匹配成功: ${matched.length} 个玩家`);
      // @ts-ignore
      const players: IPlayer[] = (await Promise.all(matched.map(req => playerService.getPlayerById(req.player_id)))).filter(v => v);

      if (players[0]) {
        const owner = players[0];
        const room = await roomService.createRoom({
          game_id,
          name: `Ranked Match - ${Date.now()}`,
          owner_id: owner?.user_id,
          members: [],
          numbers: {
            min: 2,
            max: Math.min(2, players.length)
          },
          isPrivate: false,
          settings: { mode: 'ranked' }
        });

        for (let i = 1; i < players.length; i++) {
          roomService.joinRoom(room._id as string, 'player', players[i]);
        }

        matched.forEach(req => {
          io.to(req.player_id).emit('matching:matched', {
            room_id: room._id,
            opponents: (room.members as IPlayer[])
              .filter(p => p._id !== req.player_id)
              .map(p => ({
                _id: p._id,
                nick_name: p.nick_name,
                level: p.level,
                avatar: p.avatar
              }))
          });
        });
      }
    }
  }, 1000);
}