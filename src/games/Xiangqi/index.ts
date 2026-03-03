import constant from "../../constant";
import { IMember, IRoom } from "../../types";

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
  static assignRoles(room: IRoom) {
    const players = room.members.filter(m => m.type === constant.MEMBER.TYPE.player);
    if (players[0]) players[0].role = 'red';
    if (players[1]) players[1].role = 'black';
    return players;
  }
}