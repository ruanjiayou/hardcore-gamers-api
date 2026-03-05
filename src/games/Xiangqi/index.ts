import assert from "node:assert";
import constant from "../../constant";
import { MMatch } from "../../models";
import { IMatch, IMember, IPlayer, IRoom } from "../../types";
import { cloneDeep } from "lodash";

export default class Xiangqi {
  static getInitState(room: IRoom) {
    const player = room.members.find(m => m.user_id === room.owner_id);
    return {
      current_turn: player?._id,
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
    player.role = room.members.filter(m => m.type === constant.MEMBER.TYPE.player).length === 0 ? 'red' : 'black'
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
    // 需要深克隆,不然修改位置部分失败
    const curr_state = cloneDeep(match.curr_state);

    curr_state.board[to[0]][to[1]] = curr_state.board[from[0]][from[1]];
    curr_state.board[from[0]][from[1]] = null;
    curr_state.curr_turn = next?._id;
    await MMatch.updateOne({ _id: match._id }, { $set: { curr_state, updatedAt: new Date() }, $push: { movements: { ...movement, timestamp: Date.now() } } });

    return { success: true, data: { curr_turn: movement.player_id, next_turn: next?._id, from: movement.from, to: movement.to } }
  }
}