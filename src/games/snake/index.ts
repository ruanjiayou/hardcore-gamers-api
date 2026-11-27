import { IMatch, IMember, IPlayer, IRoom } from "../../types";
import { isSnakeAngle } from "./rules";
import { snakeRuntimeService } from "../../services/SnakeRuntimeService";

/**
 * 贪吃蛇（一个游戏两种玩法，都是房间制 + 服务端权威实时推进）。
 *
 * - endless（无尽挑战，1–10 人同图）：进房即开局，死亡后停在「已出局」弹框等玩家选择
 *   （重生 / 退出）；重生在空白处随机复活并带 3s 无敌。房间没人时按各玩家最高分结算，分榜 key = endless。
 * - team（团队模式，最多 6 队 × 每队 5 人）：队友之间不互相碰撞致死，可以互相掩护；
 *   一支队伍全员出局即淘汰，只剩一队时该队获胜，分榜 key = team。
 *
 * 客户端只发三类指令（连续像素移动，没有格子/四方向）：
 * - movement.angle：期望朝向（弧度，0 = 向右）；服务端按"最小转弯半径"推导的最大角速度追过去
 *   （巡航 25px、加速 52px；角速度 = 当前速度 / 半径，所以长蛇更慢也更难转向），
 *   所以任意方向都能实时转向，也能贴着极小的圈盘旋（不会原地自转）
 * - movement.boostHeld：按住加速（速度 ×1.85、每秒扣 18px 身长、下限 120px，**无冷却**）；
 *   旧的 movement.boost 作为兼容别名保留，两者同时传时以 boostHeld 为准。
 *   语义是纯"按住"：按住一直加速，松手才停；身长扣到下限时加速暂停生效但**按住状态保留**，
 *   吃食物长回来立刻自动恢复加速
 * - movement.respawn：无尽模式死亡后重生（死亡时那次得分已经记入排行榜）
 * 指令一律 silent，由运行时统一广播快照，避免 handler 再回播一次。
 * 分数同步不在此通道：客户端点离开/关闭发 `room:sync-score`（RoomHandler 按房间取运行时分数记榜）。
 */
export default class GameSnake {
  /** 实时运行时开关（RoomHandler 开局时据此 spawn） */
  static readonly realtime = true;

  /** 两种玩法都由服务端 tick 推进 */
  static isRealtimeVariant(_variant?: string) {
    return _variant === 'team' || _variant === 'endless' || !_variant;
  }

  static getInitState(_player_id?: string) {
    return {
      curr_turn: '',
      first: 'player',
      score: 0,
    };
  }

  /**
   * 每个玩家一条蛇，角色统一 snake。
   * 团队房（GM-snake-36）：进房**不分队**——一个房 = 一队，队伍在 3 房合局时
   * 由服务端按房间顺序统一分配（SB-064）。这里不再写 member.team。
   */
  static assignRole(_room: IRoom, player: IMember) {
    player.role = 'snake';
  }

  static assignRoles(players: IPlayer[]) {
    return players.map(p => ({
      _id: p._id,
      role: 'snake',
      team: (p as any).team || '',
      score: 0,
      is_winner: false,
    }));
  }

  static isLegalMove() { }

  static async excuteMove(
    match: IMatch,
    movement: { player_id: string; angle?: number; boost?: boolean; boostHeld?: boolean; respawn?: boolean },
  ) {
    const { player_id } = movement;
    // 准入判定以服务端运行时为准（唯一权威）：
    // 无尽竞技房允许中途加入，新玩家的蛇只存在于运行时内存态，
    // 开局时写下的 match.players 名单里没有他 —— 若拿旧名单判定，
    // 他会被当成"不在局中"，转向/加速指令被静默丢弃，
    // 表现就是"进了房间却完全控制不了方向"。
    const inMatch = (match.players || []).some(p => p._id === player_id);
    const inRuntime = snakeRuntimeService.hasPlayer(match._id, player_id);
    if (!inMatch && !inRuntime) {
      return { success: false, gameover: false, data: null };
    }

    // 无尽模式：死亡弹框点「重生」（服务端会给 3s 无敌，并广播新位置）
    if (movement.respawn) {
      const ok = snakeRuntimeService.respawn(match._id, player_id);
      return { success: ok, gameover: false, data: { silent: true } };
    }

    // 加速：按住状态（true=按下、false=松开），无 CD，代价是扣身长
    const held = typeof movement.boostHeld === 'boolean'
      ? movement.boostHeld
      : (typeof movement.boost === 'boolean' ? movement.boost : null);
    if (held !== null) {
      const ok = snakeRuntimeService.setBoost(match._id, player_id, held);
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
