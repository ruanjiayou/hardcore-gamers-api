import constant from "../../constant";
import { MMatch } from "../../models";
import { IMatch, IMember, IPlayer, IRoom } from "../../types";
import { cloneDeep } from "lodash";
import { isLegalMove, hasAnyLegalMove } from "./rules";

export default class Xiangqi {
  static getInitState(player_id: string) {
    return {
      curr_turn: player_id,
      first: 'red',
      board: [
        [
          { "type": "r", "color": "black" },
          { "type": "n", "color": "black" },
          { "type": "b", "color": "black" },
          { "type": "a", "color": "black" },
          { "type": "k", "color": "black" },
          { "type": "a", "color": "black" },
          { "type": "b", "color": "black" },
          { "type": "n", "color": "black" },
          { "type": "r", "color": "black" },
        ],
        [null, null, null, null, null, null, null, null, null],
        [null, { "type": "c", "color": "black" }, null, null, null, null, null, { "type": "c", "color": "black" }, null],
        [
          { "type": "p", "color": "black" },
          null,
          { "type": "p", "color": "black" },
          null,
          { "type": "p", "color": "black" },
          null,
          { "type": "p", "color": "black" },
          null,
          { "type": "p", "color": "black" },
        ],
        [null, null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null, null],
        [
          { "type": "p", "color": "red" },
          null,
          { "type": "p", "color": "red" },
          null,
          { "type": "p", "color": "red" },
          null,
          { "type": "p", "color": "red" },
          null,
          { "type": "p", "color": "red" },
        ],
        [null, { "type": "c", "color": "red" }, null, null, null, null, null, { "type": "c", "color": "red" }, null],
        [null, null, null, null, null, null, null, null, null],
        [
          { "type": "r", "color": "red" },
          { "type": "n", "color": "red" },
          { "type": "b", "color": "red" },
          { "type": "a", "color": "red" },
          { "type": "k", "color": "red" },
          { "type": "a", "color": "red" },
          { "type": "b", "color": "red" },
          { "type": "n", "color": "red" },
          { "type": "r", "color": "red" },
        ]
      ]
    }
  }
  static assignRole(room: IRoom, player: IMember) {
    player.role = room.members.filter(m => m.member_type === constant.MEMBER.TYPE.player).length === 0 ? 'red' : 'black'
  }
  static assignRoles(players: IPlayer[]) {
    return players.map((p, idx) => ({ _id: p._id, role: idx === 0 ? 'red' : 'black', score: 0, is_winner: false }));
  }

  static isLegalMove() {

  }
  //  服务器输入输出都是idx
  static async excuteMove(match: IMatch, movement: { player_id: string; from: [number, number], to: [number, number] }) {
    const next = match.players.find(p => p._id !== movement.player_id);

    const { player_id, from, to } = movement;
    const curr_state = cloneDeep(match.curr_state);

    // 权威校验：必须轮到该玩家、角色匹配、且走法合法（防止抢走/非法着法污染对局状态）
    const player = match.players.find(p => p._id === player_id);
    if (!player || curr_state.curr_turn !== player_id) {
      return { success: false, gameover: false, data: null };
    }
    if (!isLegalMove(curr_state.board, from, to)) {
      return { success: false, gameover: false, data: null };
    }

    // 权威胜负判定，覆盖三种结束方式：
    //  1) 吃掉对方将/帅（目标格原本是 k）；
    //  2) 将死：走完后对方被将军且无任何合法应对；
    //  3) 困毙：走完后对方未被将军但也无子可走。
    // 后两种通过"对方是否还有任意合法走法"统一判定——无着可走即负，落子方获胜。
    let gameover = false;
    const capturedKing = curr_state.board[to[0]][to[1]]?.type === 'k';
    curr_state.board[to[0]][to[1]] = curr_state.board[from[0]][from[1]];
    curr_state.board[from[0]][from[1]] = null;
    if (capturedKing) {
      gameover = true;
    } else if (next) {
      const opponentColor = next.role === 'red' ? 'red' : 'black';
      gameover = !hasAnyLegalMove(curr_state.board, opponentColor);
    }
    curr_state.curr_turn = next?._id;
    // 只负责落子；对局结束的结算统一交给 RoomService.gameover（带幂等保护），
    // 避免此处直接写 MPlayer/MMatch 造成重复加分与状态不一致。
    const diff: any = {
      $set: { curr_state, updatedAt: new Date() },
      // board 快照：供对局回放按帧渲染
      $push: { movements: { ...movement, board: curr_state.board, timestamp: Date.now() } }
    }
    await MMatch.updateOne({ _id: match._id }, diff);

    return { success: true, gameover, data: { curr_turn: movement.player_id, next_turn: next?._id, from: movement.from, to: movement.to } }
  }

  static async finish() {

  }
}