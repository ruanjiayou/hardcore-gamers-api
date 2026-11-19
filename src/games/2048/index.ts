import constant from "../../constant";
import { MMatch } from "../../models";
import { IMatch, IMember, IPlayer } from "../../types";
import { cloneDeep } from "lodash";
import { checkScore } from "./rules";

/**
 * 2048：单人本地实时游戏 + 服务端权威记分。
 * - 棋盘/移动/动画/计分全部在 lobby 前端本地完成，不逐步走网络；
 * - 游戏结束时前端 emit room:player-action，movement = { player_id, score, done: true }；
 * - 服务端在此校验分数合法性，触发结算，把分数累计进 MPlayer.score（排行榜）。
 */
export default class Game2048 {
  static getInitState(_player_id?: string) {
    return {
      curr_turn: '',
      first: 'player',
      score: 0,
    };
  }

  /** 单人游戏：房主即唯一玩家，固定角色 player。 */
  static assignRole(room: IRoom, player: IMember) {
    player.role = 'player';
  }

  static assignRoles(players: IPlayer[]) {
    return players.map(p => ({ _id: p._id, role: 'player', score: 0, is_winner: false }));
  }

  static isLegalMove() {}

  static async excuteMove(match: IMatch, movement: { player_id: string; score?: number; done?: boolean }) {
    const { player_id, done } = movement;
    const me = match.players.find(p => p._id === player_id);

    // 权威校验：参与者存在 + 轮到自己（单人游戏 curr_turn 始终是自己）
    if (!me) {
      return { success: false, gameover: false, data: null };
    }

    // 中途的分数同步（done !== true）：只做分数校验，由 RoomHandler 走
    // roomService.recordSoloScore 用 $max 写入玩家最高分，不写对局、不广播——
    // 保证排行榜实时反映成绩，且中途退出不丢分。
    if (!done) {
      const checked = checkScore(movement.score ?? 0);
      if (!checked.valid) return { success: false, gameover: false, data: null };
      return {
        success: true,
        gameover: false,
        data: { curr_turn: player_id, next_turn: player_id, solo: true, score: checked.score, progress: true },
      };
    }

    // 终局上报：校验分数，触发结算。
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
      // winner 指向自己（单人完成即"获胜"）；scores 交给结算层累计；
      // score/solo 供前端结算弹窗显示"本局得分 X"。
      data: {
        curr_turn: player_id,
        next_turn: '',
        winner: player_id,
        score,
        solo: true,
        // 单人游戏按最高分计入排行榜（非累加），避免每局分数叠加虚高。
        scoreMode: 'max',
        scores: { [player_id]: score },
      },
    };
  }

  static async finish() {}
}
