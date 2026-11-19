/**
 * 计时巡检器：服务端权威判负。
 *
 * 每秒扫描所有进行中、且启用计时的对局，检查当前回合玩家的“投影剩余额度”。
 * 若额度耗尽（含本回合超出步时限的部分），自动结算为对方胜并广播 game-over。
 * 这样即使玩家一直不落子（例如挂机/断线），也能及时判负，不依赖客户端上报。
 */
import type { Server } from 'socket.io';
import { MMatch, MPlayer } from '../models';
import { roomService } from './RoomService';
import { pick } from 'lodash';
import constant from '../constant';
import { findTimeout, clockSnapshot, type MatchTimeControl } from '../utils/timeControl';

export class TimeControlService {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 启动巡检（幂等） */
  start(io: Server, intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(io), intervalMs);
    // 不阻止进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref();
    console.log('⏱️  计时巡检器已启动');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(io: Server) {
    const now = Date.now();
    let matches: any[] = [];
    try {
      matches = await MMatch.find({
        status: constant.MATCH.STATUS.playing,
        'curr_state.timeControl.enabled': true,
      }).lean(true);
    } catch {
      return;
    }

    for (const match of matches) {
      const tc = match.curr_state?.timeControl as MatchTimeControl | undefined;
      if (!tc?.enabled) continue;
      const currTurn = match.curr_state?.curr_turn;
      const timeoutLoser = findTimeout(tc, currTurn, now);
      if (!timeoutLoser) {
        // 未超时也周期性广播时钟，让双方倒计时保持同步（客户端据此校正服务端时间偏移）
        io.to(`room:${match.room_id}`).emit('room:clock', clockSnapshot(match._id, tc, currTurn, now));
        continue;
      }

      // 超时判负：幂等的 gameover 由 roomService 保证，重复巡检不会重复结算
      const winner = match.players.find((p: any) => p._id !== timeoutLoser);
      await roomService.gameover(match.room_id, match._id, winner?._id as string);
      const winnerPlayer = winner && await MPlayer.findById(winner._id).lean(true);
      io.to(`room:${match.room_id}`).emit('room:game-over', {
        ...pick(winnerPlayer || {}, ['_id', 'nickname']),
        reason: 'timeout',
        timeoutPlayerId: timeoutLoser,
      });
      console.log(`⏱️  对局 ${match._id} 玩家 ${timeoutLoser} 超时判负`);
    }
  }
}

export const timeControlService = new TimeControlService();
