import constant from "../../constant";
import { MMatch } from "../../models";
import { IMatch, IMember, IPlayer, IRoom } from "../../types";
import { cloneDeep } from "lodash";

export default class Gomoku {
  static getInitState() {
    return {
      curr_turn: '',
      players: [],
      board: {} // { [key:string]: string}
    }
  }
  static assignRole(room: IRoom, player: IMember) {
    player.role = room.members.filter(m => m.member_type === constant.MEMBER.TYPE.player).length === 0 ? 'black' : 'white'
  }
  static assignRoles(players: IPlayer[]) {
    return players.map((p, idx) => ({ _id: p._id, role: idx === 0 ? 'black' : 'white', score: 0, is_winner: false }));
  }
  static getNewBoard(map: Map<string, string>) {
    const board = Array(15).fill([]).map(() => Array(15).fill(0));
    map.forEach((v, k) => {
      const [x, y] = k.split('|').map(n => parseInt(n, 10));
      board[x][y] = !v ? 0 : (v === 'black' ? 1 : 2);
    })
    return board;
  }
  //  服务器输入输出都是idx
  static async excuteMove(match: IMatch, movement: { player_id: string; to: { x: number, y: number, role: string } }) {
    const next = match.players.find(p => p._id !== movement.player_id);

    const { player_id, to } = movement;
    let gameover = false;
    // 需要深克隆,不然修改位置部分失败
    const curr_state = cloneDeep(match.curr_state);
    const player = match.players.find(p => p._id === player_id);
    if (!player || player.role !== to.role || curr_state.curr_turn !== player._id) {
      return { success: false };
    }
    const position = `${to.x}|${to.y}`
    if (curr_state.board[position]) {
      return { success: false, gameover }
    }
    curr_state.board[position] = to.role;
    curr_state.curr_turn = next?._id;
    const diff: any = { $set: { curr_state, updatedAt: new Date() }, $push: { movements: { ...movement, timestamp: Date.now() } } }
    gameover = this.checkWin(curr_state, to)
    await MMatch.updateOne({ _id: match._id }, diff);
    return {
      success: true,
      gameover,
      data: { curr_turn: movement.player_id, next_turn: !gameover ? next?._id : '', to },
    }
  }

  static checkWin(state: any, to: { x: number, y: number, role: string }): boolean {
    // 方向向量：右、下、右下、右上
    const directions = [
      [[1, 0], [-1, 0]],   // 水平
      [[0, 1], [0, -1]],   // 垂直
      [[1, 1], [-1, -1]],  // 对角线
      [[1, -1], [-1, 1]]   // 反对角线
    ];

    for (const [dir1, dir2] of directions) {
      let count = 1;
      // 方向1
      for (let m = 1; m <= 4; m++) {
        const x2 = to.x + dir1[0] * m;
        const y2 = to.y + dir1[1] * m;
        if (state.board[`${x2}|${y2}`] !== to.role) {
          break;
        }
        count++;
      }
      // 方向2
      for (let n = 1; n <= 4; n++) {
        const x2 = to.x + dir2[0] * n;
        const y2 = to.y + dir2[1] * n;
        if (state.board[`${x2}|${y2}`] !== to.role) {
          break;
        }
        count++;
      }
      if (count >= 5) {
        return true;
      }
    }
    return false;
  }

  static async finish() {

  }
}