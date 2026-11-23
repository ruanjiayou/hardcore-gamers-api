import constant from "../../constant";
import { MMatch } from "../../models";
import { IMatch, IMember, IPlayer, IRoom } from "../../types";
import { cloneDeep } from "lodash";
import {
  Board, OthelloColor, Pos, createInitialBoard, flipsFor, applyMove,
  hasLegalMove, isGameOver, countDiscs, opponent,
} from "./rules";

export default class Othello {
  static getInitState(_player_id?: string) {
    return {
      curr_turn: '',
      first: 'black',
      board: createInitialBoard(),
    };
  }

  static assignRole(room: IRoom, player: IMember) {
    player.role = room.members.filter(m => m.member_type === constant.MEMBER.TYPE.player).length === 0 ? 'black' : 'white';
  }

  static assignRoles(players: IPlayer[]) {
    return players.map((p, idx) => ({ _id: p._id, role: idx === 0 ? 'black' : 'white', score: 0, is_winner: false }));
  }

  static isLegalMove() {}

  static async excuteMove(match: IMatch, movement: { player_id: string; to: Pos }) {
    const { player_id, to } = movement;
    const curr_state = cloneDeep(match.curr_state);
    const board: Board = curr_state.board;
    const me = match.players.find(p => p._id === player_id);

    // 权威校验：轮次 + 角色存在
    if (!me || curr_state.curr_turn !== player_id) {
      return { success: false, gameover: false, data: null };
    }
    const color: OthelloColor = me.role === 'white' ? 'white' : 'black';

    // 跳过回合：仅当本方确实无合法落子时允许
    if (to[0] === -1 && to[1] === -1) {
      if (hasLegalMove(board, color)) {
        return { success: false, gameover: false, data: null };
      }
      const { endGame, nextTurn } = this.decidePassTurn(board, color, match.players);
      if (endGame) {
        // 双方都无法落子 → 终局，按子数判胜
        const winnerId = this.settleWinner(match, board);
        curr_state.curr_turn = '';
        await MMatch.updateOne({ _id: match._id }, {
          $set: { curr_state, updatedAt: new Date() },
          $push: { movements: { ...movement, timestamp: Date.now() } },
        });
        return {
          success: true,
          gameover: true,
          data: { curr_turn: player_id, next_turn: '', to, pass: true, color, winner: winnerId },
        };
      }
      // 合法跳过：回合交给对方。旧实现把 curr_turn 留给自己，导致
      // 玩家反复被要求跳过 / 机器人 pass 后因 isMine 不再触发落子，对局卡死不判胜负。
      curr_state.curr_turn = nextTurn;
      await MMatch.updateOne({ _id: match._id }, {
        $set: { curr_state, updatedAt: new Date() },
        $push: { movements: { ...movement, timestamp: Date.now() } },
      });
      return {
        success: true,
        gameover: false,
        data: { curr_turn: player_id, next_turn: nextTurn, to, pass: true, color },
      };
    }

    // 正常落子：校验是合法着法并翻转
    const flips = flipsFor(board, to[0], to[1], color);
    if (flips.length === 0 || !applyMove(board, to[0], to[1], color, flips)) {
      return { success: false, gameover: false, data: null };
    }

    const nextPlayer = match.players.find(p => p._id !== player_id);
    const foe = opponent(color);
    let gameover = false;
    let nextTurn = '';
    let winner: string | undefined;

    if (isGameOver(board)) {
      gameover = true;
      winner = this.settleWinner(match, board);
    } else if (hasLegalMove(board, foe)) {
      // 对方有棋可下 → 正常轮换
      nextTurn = nextPlayer?._id ?? '';
    } else {
      // 对方无棋可下 → 对方跳过，回合仍归落子方
      nextTurn = player_id;
    }
    curr_state.curr_turn = nextTurn;

    await MMatch.updateOne({ _id: match._id }, {
      $set: { curr_state, updatedAt: new Date() },
      $push: { movements: { ...movement, timestamp: Date.now() } },
    });

    return {
      success: true,
      gameover,
      data: {
        curr_turn: player_id,
        next_turn: nextTurn,
        to,
        color,
        flips,
        skip: !gameover && nextTurn === player_id, // 提示前端对手被跳过
        ...(gameover ? { winner } : {}),
      },
    };
  }

  /**
   * 我方无子可落、请求跳过时的回合决策（纯函数，便于测试）。
   * - 对方也无棋 → 终局，nextTurn 为空（双方都无合法落子）
   * - 对方有棋 → 回合交给对方
   */
  static decidePassTurn(board: Board, color: OthelloColor, players: IPlayer[]) {
    const foe = opponent(color);
    const endGame = !hasLegalMove(board, foe);
    const nextTurn = endGame ? '' : (players.find(p => p.role === foe)?._id ?? '');
    return { endGame, nextTurn };
  }

  /** 按最终子数判胜，返回胜者 player_id；相等返回 ''（平局） */
  private static settleWinner(match: IMatch, board: Board): string {
    const { black, white } = countDiscs(board);
    if (black === white) return '';
    const winnerColor: OthelloColor = black > white ? 'black' : 'white';
    return match.players.find(p => p.role === winnerColor)?._id ?? '';
  }

  static async finish() {}
}
