import constant from "../../constant";
import { MMatch } from "../../models";
import { IMatch, IMember, IPlayer, IRoom } from "../../types";
import { cloneDeep } from "lodash";
import {
  createInitialState, applyAction, findLegalMove, gameStatus, opponent,
  type Color, type Action, type GameState,
} from "./rules";

export default class Chess {
  static getInitState(_player_id?: string) {
    return { curr_turn: '', ...createInitialState() };
  }

  static assignRole(room: IRoom, player: IMember) {
    player.role = room.members.filter(m => m.member_type === constant.MEMBER.TYPE.player).length === 0 ? 'white' : 'black';
  }

  static assignRoles(players: IPlayer[]) {
    return players.map((p, idx) => ({ _id: p._id, role: idx === 0 ? 'white' : 'black', score: 0, is_winner: false }));
  }

  static isLegalMove() {}

  static async excuteMove(match: IMatch, movement: {
    player_id: string;
    from: [number, number];
    to: [number, number];
    promotion?: string;
  }) {
    const { player_id, from, to } = movement;
    const curr_state = cloneDeep(match.curr_state) as GameState;
    const me = match.players.find(p => p._id === player_id);

    if (!me || curr_state.curr_turn !== player_id) {
      return { success: false, gameover: false, data: null };
    }
    const color: Color = me.role === 'black' ? 'black' : 'white';

    const action: Action = {
      from,
      to,
      promotion: (movement.promotion as Action['promotion']) || undefined,
    };
    const legal = findLegalMove(curr_state, color, action);
    if (!legal) {
      return { success: false, gameover: false, data: null };
    }

    const next = match.players.find(p => p._id !== player_id);
    const nextState = applyAction(curr_state, legal);
    const foe: Color = opponent(color);
    const status = gameStatus(nextState, foe);

    let gameover = false;
    let winner: string | undefined;
    if (status === 'checkmate') {
      gameover = true;
      winner = player_id; // 将死：落子方胜
    } else if (status === 'stalemate' || status === 'fifty') {
      gameover = true;
      winner = ''; // 逼和 / 50 步规则：平局
    }
    const nextTurn = gameover ? '' : (next?._id ?? '');
    nextState.curr_turn = nextTurn;

    await MMatch.updateOne({ _id: match._id }, {
      $set: { curr_state: nextState, updatedAt: new Date() },
      $push: { movements: { ...movement, timestamp: Date.now() } },
    });

    return {
      success: true,
      gameover,
      data: {
        curr_turn: player_id,
        next_turn: nextTurn,
        from,
        to,
        promotion: legal.promotion,
        castle: legal.castle,
        enPassant: legal.enPassant,
        ...(gameover ? { winner, reason: status } : {}),
      },
    };
  }

  static async finish() {}
}
