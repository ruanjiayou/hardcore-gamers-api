import constant from "../../constant";
import { MMatch } from "../../models";
import { IMatch, IMember, IPlayer, IRoom } from "../../types";

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
  static async excuteMove(match: IMatch, movement: { player_id: string; from: { x: number, y: number }, to: { x: number, y: number } }) {
    // TODO: xy idx转换
    console.log(movement, 'movement')
    const next = match.players.find(p => p._id !== movement.player_id);

    const curr_state = match.curr_state;
    const src = curr_state.board[movement.from.x][movement.from.y];
    const dst = curr_state.board[movement.to.x][movement.to.y]
    console.log(src, dst)
    curr_state.board[movement.to.x][movement.to.y] = curr_state.board[movement.from.x][movement.from.y];
    curr_state.board[movement.from.x][movement.from.y] = null;
    curr_state.curr_turn = next?._id;
    const result = await MMatch.updateOne({ _id: match._id }, { $set: { curr_state, updatedAt: new Date() }, $push: { movements: { ...movement, timestamp: Date.now() } } });
    console.log(result)
    return { success: true, data: { curr_turn: movement.player_id, next_turn: next?._id, from: movement.from, to: movement.to } }
  }
}