import { MMatch } from "../../models";
import { IMatch, IMember, IPlayer, IRoom } from "../../types";
import { cloneDeep } from "lodash";
import { checkScore } from "./rules";

/**
 * 俄罗斯方块：单人本地实时游戏 + 服务端权威记分（与 2048 同构）。
 * - 方块生成/移动/旋转/消行/计分全部在 lobby 前端本地完成，不逐步走网络；
 * - 中途用 done=false 上报最高分（服务端 $max 实时更新排行榜）；
 * - 顶出/结束用 done=true 触发结算，分数按最高分计入 MPlayer.score。
 */
export default class GameTetris {
  static getInitState(_player_id?: string) {
    return {
      curr_turn: '',
      first: 'player',
      score: 0,
    };
  }

  /** 单人游戏：房主即唯一玩家，固定角色 player。 */
  static assignRole(_room: IRoom, player: IMember) {
    player.role = 'player';
  }

  static assignRoles(players: IPlayer[]) {
    return players.map(p => ({ _id: p._id, role: 'player', score: 0, is_winner: false }));
  }

  static isLegalMove() {}

  static async excuteMove(match: IMatch, movement: { player_id: string; score?: number; done?: boolean }) {
    const { player_id, done } = movement;
    const me = match.players.find(p => p._id === player_id);

    if (!me) {
      return { success: false, gameover: false, data: null };
    }

    // 中途进度同步：只校验分数，由 RoomHandler 走 recordSoloScore（$max 最高分）
    if (!done) {
      const checked = checkScore(movement.score ?? 0);
      if (!checked.valid) return { success: false, gameover: false, data: null };
      return {
        success: true,
        gameover: false,
        data: { curr_turn: player_id, next_turn: player_id, solo: true, score: checked.score, progress: true },
      };
    }

    // 终局上报：校验分数并结算
    const checked = checkScore(movement.score ?? 0);
    if (!checked.valid) {
      return { success: false, gameover: false, data: null };
    }
    const score = checked.score;
    const curr_state = cloneDeep(match.curr_state);
    curr_state.score = score;
    curr_state.curr_turn = '';
    await MMatch.updateOne({ _id: match._id }, {
      $set: { curr_state, updatedAt: new Date() },
      $push: { movements: { ...movement, timestamp: Date.now() } },
    });

    return {
      success: true,
      gameover: true,
      data: {
        curr_turn: player_id,
        next_turn: '',
        winner: player_id,
        score,
        solo: true,
        // 单人游戏按最高分计入排行榜（非累加）
        scoreMode: 'max',
        scores: { [player_id]: score },
      },
    };
  }

  static async finish() {}
}
