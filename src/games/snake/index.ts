import { IMatch, IMember, IPlayer, IRoom } from "../../types";
import { isSnakeAngle } from "./rules";
import { snakeRuntimeService } from "../../services/SnakeRuntimeService";

/**
 * 贪吃蛇（一个游戏两种玩法，都是房间制 + 服务端权威实时推进）。
 *
 * - endless（无尽挑战，1–6 人同图）：进房即开局，死亡后停在「已出局」弹框等玩家选择
 *   （重生 / 退出）；重生在空白处随机复活并带 3s 无敌。房间没人时按各玩家最高分结算，分榜 key = endless。
 * - multi（多人对战，2–4 人）：淘汰制，活到最后者获胜，分榜 key = multi。
 *
 * 客户端只发三类指令（连续像素移动，没有格子/四方向）：
 * - movement.angle：期望朝向（弧度，0 = 向右）；服务端按"最小转弯半径 26px"推导的最大角速度追过去，
 *   所以任意方向都能实时转向，也能贴着极小的圈盘旋（不会原地自转）
 * - movement.boost：加速（3s 内速度 x1.85，冷却 60s，服务端校验）
 * - movement.respawn：无尽模式死亡后重生（死亡时那次得分已经记入排行榜）
 * 指令一律 silent，由运行时统一广播快照，避免 handler 再回播一次。
 * 分数同步不在此通道：客户端点离开/关闭发 `room:sync-score`（RoomHandler 按房间取运行时分数记榜）。
 */
export default class GameSnake {
  /** 实时运行时开关（RoomHandler 开局时据此 spawn） */
  static readonly realtime = true;

  /** 两种玩法都由服务端 tick 推进 */
  static isRealtimeVariant(_variant?: string) {
    return _variant === 'multi' || _variant === 'endless' || !_variant;
  }

  static getInitState(_player_id?: string) {
    return {
      curr_turn: '',
      first: 'player',
      score: 0,
    };
  }

  /** 每个玩家一条蛇，角色统一 snake（座位由分配顺序决定）。 */
  static assignRole(_room: IRoom, player: IMember) {
    player.role = 'snake';
  }

  static assignRoles(players: IPlayer[]) {
    return players.map(p => ({ _id: p._id, role: 'snake', score: 0, is_winner: false }));
  }

  static isLegalMove() { }

  static async excuteMove(
    match: IMatch,
    movement: { player_id: string; angle?: number; boost?: boolean; respawn?: boolean },
  ) {
    const { player_id } = movement;
    const me = match.players.find(p => p._id === player_id);
    if (!me) {
      return { success: false, gameover: false, data: null };
    }

    // 无尽模式：死亡弹框点「重生」（服务端会给 3s 无敌，并广播新位置）
    if (movement.respawn) {
      const ok = snakeRuntimeService.respawn(match._id, player_id);
      return { success: ok, gameover: false, data: { silent: true } };
    }

    // 加速：服务端校验冷却，成功后立刻广播一次（按钮反馈不用等下一个 tick）
    if (movement.boost) {
      const ok = snakeRuntimeService.boost(match._id, player_id);
      return { success: ok, gameover: false, data: { silent: true } };
    }

    // 转向：记录期望朝向，运行时按最大角速度追过去
    if (isSnakeAngle(movement.angle)) {
      const ok = snakeRuntimeService.steer(match._id, player_id, movement.angle);
      return { success: ok, gameover: false, data: { silent: true } };
    }

    return { success: false, gameover: false, data: null };
  }

  static async finish() { }
}
