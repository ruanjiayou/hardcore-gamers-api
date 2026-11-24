/**
 * 贪吃蛇实时运行时。
 *
 * 职责：对每个进行中的贪吃蛇对局维护一个内存状态，按固定 tick 推进并广播快照。
 * - 服务端权威：方向/加速指令只改内存状态，移动/碰撞/吃食物全在服务端算；
 * - 两种玩法同一套运行时：
 *   · endless（无尽挑战，1–10 人同图）：死亡自动重生（3s 无敌），对局永不结束，
 *     直到房间没人/被解散时统一结算（按各玩家历史最高分记 endless 榜）；
 *   · team（团队模式，最多 6 队 × 每队 5 人）：队友之间不互相碰撞致死，
 *     一支队伍全员出局即淘汰，只剩一队时该队获胜（记 team 榜）；
 * - 每 10 个 tick 落库一次 curr_state.snake，断线重进能拿到接近实时的局面；
 * - 结束时调用注入的 finish hook（由 index.ts 接到 roomService.gameover），
 *   避免运行时反向依赖 RoomService 造成循环引用。
 */
import type { Server } from 'socket.io';
import { MMatch, MPlayer, MRoom } from '../models';
import constant from '../constant';
import {
  SNAKE_BOOST_CD_MS,
  SNAKE_RADIUS,
  SNAKE_TICK_MS,
  addSnake as addSnakeToState,
  boostSnake as boostState,
  createSnakeState,
  isSnakeVariant,
  respawnSnake as respawnSnakeState,
  snakeScores,
  snakeSpine,
  steerSnake as steerState,
  stepSnake,
  type SnakeFoodItem,
  type SnakeState,
  type SnakeVariant,
} from '../games/snake/rules';

export interface SnakeFinishInfo {
  room_id: string;
  match_id: string;
  /** 胜者 player_id；'' 表示平局/无尽模式无胜者 */
  winner: string;
  /** player_id -> 本局得分 */
  scores: Record<string, number>;
  variant: SnakeVariant;
}

export type SnakeFinishHook = (info: SnakeFinishInfo) => Promise<void> | void;

interface Runtime {
  match_id: string;
  room_id: string;
  variant: SnakeVariant;
  state: SnakeState;
  /** 对局初始状态（players/variant 等），落库时与快照合并 */
  base: Record<string, any>;
  timer: ReturnType<typeof setTimeout> | null;
  /** 上一 tick 的时间戳，用来算真实 dt（定时器会漂移，不能假定正好 50ms） */
  lastTickAt: number;
  /** player_id -> 昵称：局中加人时 curr_state.players 不会更新，名字单独记在这里 */
  names: Map<string, string>;
}

/** 网络快照：连续像素坐标 + 等距身体采样，客户端据此插值/预测 */
export interface SnakeSnapshot {
  /** 世界宽高（像素） */
  w: number;
  h: number;
  /** 蛇身半径，客户端绘制用（避免两端常量不同步） */
  radius: number;
  tick: number;
  variant: SnakeVariant;
  /** 座位表（id + 昵称 + 队伍），客户端据此显示玩家名与头顶标签 */
  players: { id: string; nickname: string; team: string }[];
  /** 场上可拾取物：普通食物（分档）/ 尸体残骸 / 磁铁 / 闪电 */
  food: SnakeFoodItem[];
  snakes: {
    id: string;
    /** 所属队伍（团队模式）；空串表示无队伍 */
    team: string;
    /** 蛇头坐标（像素） */
    x: number;
    y: number;
    /** 朝向（弧度，0 = 向右） */
    angle: number;
    /** 身体中心线，从蛇头开始等距采样（SNAKE_SEG_SPACING） */
    pts: [number, number][];
    /** 身长（像素） */
    length: number;
    alive: boolean;
    score: number;
    best: number;
    /** 剩余无敌时间（ms），0 表示没有 */
    invincible: number;
    /** 剩余加速时间（ms） */
    boosting: number;
    /** 加速冷却剩余（ms） */
    boostCd: number;
    /** 磁铁效果剩余时间（ms），0 表示没有 */
    magnet: number;
    /** 闪电加速剩余时间（ms），0 表示没有 */
    lightning: number;
    /** 距离重生还有多久（ms）；改为玩家手动重生后恒为 0，仅保留字段兼容旧客户端 */
    respawnIn: number;
    /** 已出局、正在等玩家选择「重生 / 退出」（无尽模式） */
    awaiting: boolean;
    /** 已重生次数（客户端据此判断"整条蛇瞬移到别处"，镜头直接对齐） */
    respawns: number;
  }[];
  status: 'playing' | 'over';
  winner: string;
  /** 团队模式下各队总积分：team -> 分数 */
  teamScores: Record<string, number>;
}

export class SnakeRuntimeService {
  private io: Server | null = null;
  private hook: SnakeFinishHook | null = null;
  private runtimes = new Map<string, Runtime>();

  start(io: Server, hook: SnakeFinishHook) {
    this.io = io;
    this.hook = hook;
    console.log('🐍 贪吃蛇运行时已就绪（无尽 + 多人）');
  }

  /**
   * 服务重启后，进行中的对局失去 tick 循环会永久卡在 playing。
   * 启动时统一收尾（判为已结束、房间回等待态），避免房间列表长期显示"游戏中"。
   */
  async resetStaleMatches() {
    const stale = await MMatch.find({
      game_id: 'snake',
      status: constant.MATCH.STATUS.playing,
    }, { _id: 1, room_id: 1 }).lean(true);
    for (const match of stale) {
      await MMatch.updateOne(
        { _id: match._id, status: constant.MATCH.STATUS.playing },
        { $set: { status: constant.MATCH.STATUS.gameover, updatedAt: new Date() } },
      );
      if (match.room_id) {
        // 已解散（软删）的房间不能借重启"复活"，否则会冒出列表里看不到的幽灵房
        await MRoom.updateOne(
          { _id: match.room_id, status: { $ne: constant.ROOM.STATUS.deleted } },
          { $set: { status: constant.ROOM.STATUS.waiting, match_id: '', updatedAt: new Date() } },
        );
      }
    }
    if (stale.length) console.log(`🧹 已回收 ${stale.length} 个中断的贪吃蛇对局`);
  }

  /** 开局：按对局玩家建蛇并启动 tick 循环 */
  spawn(match: { _id: string; room_id: string; curr_state: any }) {
    if (!this.io) return;
    if (this.runtimes.has(match._id)) return;

    const rawVariant = match.curr_state?.variant;
    const variant: SnakeVariant = isSnakeVariant(rawVariant) ? rawVariant : 'team';
    const players = (match.curr_state?.players || [])
      .filter((p: any) => p.member_type === constant.MEMBER.TYPE.player);
    const ids = players.map((p: any) => p._id as string);
    // 无尽模式 1 人即可开局；团队模式至少 2 人
    if (ids.length < (variant === 'endless' ? 1 : 2)) return;

    // 队伍映射：player_id -> team（团队模式）
    const teams: Record<string, string> = {};
    for (const p of players) {
      if (p?._id && p.team) teams[String(p._id)] = String(p.team);
    }

    const state = createSnakeState(ids, { variant, teams, random: Math.random });
    const names = new Map<string, string>();
    for (const p of match.curr_state?.players || []) {
      if (p?._id) names.set(String(p._id), p.nickname || '玩家');
    }
    const rt: Runtime = {
      match_id: match._id,
      room_id: match.room_id,
      variant,
      state,
      base: match.curr_state || {},
      timer: null,
      lastTickAt: Date.now(),
      names,
    };
    this.runtimes.set(match._id, rt);
    this.broadcast(rt);
    void this.fillNames(rt);
    this.schedule(rt);
    console.log(`🐍 贪吃蛇 ${variant} 对局 ${match._id} 启动，玩家数 ${ids.length}`);
  }

  /**
   * 补齐昵称：房间成员表里只有 _id / 角色，没有昵称，
   * 首帧先用"玩家"占位，这里异步查一次玩家表填上（下一帧广播就带名字了）。
   */
  private async fillNames(rt: Runtime) {
    const ids = rt.state.snakes.map(s => s.id).filter(Boolean);
    if (!ids.length) return;
    try {
      const players = await MPlayer.find({ _id: { $in: ids } }, { nickname: 1 }).lean(true);
      for (const p of players) {
        const name = (p as any)?.nickname;
        if (name) rt.names.set(String((p as any)._id), name);
      }
    } catch (error) {
      console.log('❌ 贪吃蛇昵称回填失败:', error);
    }
  }

  /** 客户端转向指令：目标朝向（任意弧度），服务端按最大角速度追过去 */
  steer(match_id: string, player_id: string, angle: number): boolean {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    return steerState(rt.state, player_id, angle);
  }

  /**
   * 该玩家是否在这局里（服务端运行时为准）。
   *
   * 无尽竞技房允许中途加入：加入者的蛇只存在于运行时内存态，
   * 旧逻辑用开局时写的 match.players 做准入判定，会把这类玩家判成"不在局中"，
   * 转向指令被直接丢弃 —— 表现就是"进了房间却完全控制不了方向"。
   */
  hasPlayer(match_id: string, player_id: string): boolean {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    return rt.state.snakes.some(s => s.id === player_id);
  }

  /** 加速（有冷却，服务端权威） */
  boost(match_id: string, player_id: string): boolean {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    const ok = boostState(rt.state, player_id);
    if (ok) this.broadcast(rt);
    return ok;
  }

  /**
   * 认输 = 自我淘汰（仅多人对战有意义）：保留对局继续推进，让剩余玩家分出胜负。
   */
  eliminate(match_id: string, player_id: string): boolean {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    const snake = rt.state.snakes.find(s => s.id === player_id);
    if (!snake || !snake.alive) return false;
    snake.alive = false;
    return true;
  }

  /**
   * 中途加入无尽竞技房：在空白处放一条新蛇（带 3s 重生保护），
   * 并把加入者回写进对局记录（内存基线 + MMatch.players + curr_state.players）。
   *
   * 回写是必须的，开局时写入的名单只包含开局那一刻的人：
   * ① 转向指令的准入判定若只认开局名单，中途加入者会被当成局外人，指令被静默丢弃；
   * ② 结算时 scores 表与玩家列表会对不上；
   * ③ 服务端重启后按库重建运行时（spawn 只认 curr_state.players）会把他整个丢掉。
   */
  async addPlayer(match_id: string, player_id: string, nickname?: string): Promise<boolean> {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    if (nickname) rt.names.set(player_id, nickname);
    if (rt.state.snakes.some(s => s.id === player_id)) return true;
    const snake = addSnakeToState(rt.state, player_id, Math.random);
    snake.invincibleUntil = Date.now() + 3000;
    await this.syncMatchMembers(rt, player_id, nickname);
    this.broadcast(rt);
    return true;
  }

  /**
   * 把中途加入者同步进对局记录。
   * 队伍信息取自房间成员表（团队模式下加入时落到具体队伍）。
   */
  private async syncMatchMembers(rt: Runtime, player_id: string, nickname?: string) {
    try {
      const room = await MRoom.findById(rt.room_id).lean(true) as any;
      const member = (room?.members || []).find((m: any) => m._id === player_id);
      const memberSnapshot = {
        _id: player_id,
        role: member?.role || 'snake',
        team: member?.team || '',
        player_type: member?.player_type || constant.PLAYER.TYPE.player,
        member_type: member?.member_type || constant.MEMBER.TYPE.player,
        ...(nickname ? { nickname } : {}),
      };
      // 内存基线：persist 会带上 players，服务端重启后 spawn 依赖它重建运行时
      const basePlayers: any[] = Array.isArray(rt.base?.players) ? rt.base.players : [];
      if (!basePlayers.some((p: any) => p._id === player_id)) {
        rt.base = { ...rt.base, players: [...basePlayers, memberSnapshot] };
      }
      await MMatch.updateOne(
        { _id: rt.match_id },
        {
          $push: {
            'curr_state.players': memberSnapshot,
            players: {
              _id: player_id,
              role: memberSnapshot.role,
              team: memberSnapshot.team,
              score: 0,
              is_winner: false,
            },
          },
        },
      );
    } catch (error) {
      console.log('❌ 贪吃蛇中途加入者回写对局失败:', error);
    }
  }

  /** 中途退出：把这条蛇从本局移除（其他人的对局继续） */
  removePlayer(match_id: string, player_id: string): boolean {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    const idx = rt.state.snakes.findIndex(s => s.id === player_id);
    if (idx < 0) return false;
    // 无论从哪条路径被移除，都先把这一命的分数记榜（$max 幂等）
    void this.commitScore(rt, player_id);
    rt.state.snakes.splice(idx, 1);
    this.broadcast(rt);
    return true;
  }

  /** 实时快照（断线重进时给前端补齐到最新局面） */
  snapshot(match_id: string): SnakeSnapshot | null {
    const rt = this.runtimes.get(match_id);
    return rt ? this.toSnapshot(rt) : null;
  }

  /**
   * 无尽模式手动重生：死亡弹框里点「重生」时调用。
   * 随机空白位置 + 3s 无敌，本条命分数归零（best 保留）。
   */
  respawn(match_id: string, player_id: string): boolean {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    if (rt.variant !== 'endless') return false;
    const ok = respawnSnakeState(rt.state, player_id, Date.now(), Math.random);
    if (ok) this.broadcast(rt);
    return ok;
  }

  /**
   * 玩家点「离开 / 关闭」时同步分数：按运行时局面取分写榜（客户端不带分数，防篡改）。
   * 与死亡结算共用 commitScore，$max 幂等，重复点击不会把分数叠上去。
   */
  async syncScore(match_id: string, player_id: string): Promise<boolean> {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    await this.commitScore(rt, player_id);
    return true;
  }

  /** 断线兜底：只知道房间 id 时也能把该玩家的分数结算掉 */
  async syncScoreByRoom(room_id: string, player_id: string): Promise<boolean> {
    const rt = [...this.runtimes.values()].find(r => r.room_id === room_id);
    if (!rt) return false;
    await this.commitScore(rt, player_id);
    return true;
  }

  /**
   * 死亡即结算：把这条命（或这一局）的分数写进排行榜。
   *
   * 无尽模式的对局"永不结束"，只在房间没人时才统一结算；玩家的分数不能等到那时，
   * 死亡弹框出现的瞬间就要上榜（$max：只刷新历史最高，不累加）。
   */
  private async commitScore(rt: Runtime, player_id: string) {
    const snake = rt.state.snakes.find(s => s.id === player_id);
    const score = Math.floor(snake?.score || 0);
    if (score <= 0) return;
    const board = rt.variant === 'endless' ? 'endless' : 'team';
    try {
      await MPlayer.updateOne(
        { _id: player_id },
        { $max: { score, [`boards.${board}`]: score } },
      );
    } catch (error) {
      console.log('❌ 贪吃蛇分数上榜失败:', error);
    }
  }

  /**
   * 结束并结算：无尽模式没有自然终局，房间没人/被解散时由房间服务调用。
   * 幂等：运行时已被移除时直接返回。
   */
  async stopAndFinish(match_id: string) {
    const rt = this.runtimes.get(match_id);
    if (!rt) return;
    if (rt.timer) clearTimeout(rt.timer);
    this.runtimes.delete(match_id);
    await this.persist(rt);
    try {
      await this.hook?.({
        room_id: rt.room_id,
        match_id: rt.match_id,
        winner: rt.state.winner,
        scores: snakeScores(rt.state),
        variant: rt.variant,
      });
    } catch (error) {
      console.log('❌ 贪吃蛇结算失败:', error);
    }
  }

  /** 房间销毁/无人时清理运行时（不再结算，房间都没了） */
  stop(match_id: string) {
    const rt = this.runtimes.get(match_id);
    if (!rt) return;
    if (rt.timer) clearTimeout(rt.timer);
    this.runtimes.delete(match_id);
  }

  has(match_id: string): boolean {
    return this.runtimes.has(match_id);
  }

  private schedule(rt: Runtime) {
    // 补偿 tick 内部耗时（step + 广播 + 落库），否则实际频率会一路掉到 16Hz 以下
    const spent = Date.now() - rt.lastTickAt;
    const delay = Math.max(5, SNAKE_TICK_MS - spent);
    rt.timer = setTimeout(() => { void this.tick(rt); }, delay);
  }

  private async tick(rt: Runtime) {
    rt.timer = null;
    if (!this.runtimes.has(rt.match_id)) return;

    // 定时器会漂移（GC / 事件循环忙）：用真实经过时间推进，速度才稳定
    const now = Date.now();
    const dt = Math.min(0.25, Math.max(0.004, (now - rt.lastTickAt) / 1000));
    rt.lastTickAt = now;

    const result = stepSnake(rt.state, { dt, now });
    // 死亡瞬间就把分数记榜（无尽模式的弹框此时出现，玩家可能直接退出）
    for (const id of result.died) void this.commitScore(rt, id);
    this.broadcast(rt);

    // 每 10 个 tick（约 1s）落库一次，控制写库频率
    if (rt.state.tick % 10 === 1) void this.persist(rt);

    if (result.over) {
      this.runtimes.delete(rt.match_id);
      await this.persist(rt);
      try {
        await this.hook?.({
          room_id: rt.room_id,
          match_id: rt.match_id,
          winner: rt.state.winner,
          scores: snakeScores(rt.state),
          variant: rt.variant,
        });
      } catch (error) {
        console.log('❌ 贪吃蛇结算失败:', error);
      }
      return;
    }

    this.schedule(rt);
  }

  private broadcast(rt: Runtime) {
    this.io?.to(`room:${rt.room_id}`).emit('room:player-action', { snake: this.toSnapshot(rt) });
  }

  private async persist(rt: Runtime) {
    try {
      await MMatch.updateOne(
        { _id: rt.match_id },
        { $set: { curr_state: { ...rt.base, snake: this.toSnapshot(rt) }, updatedAt: new Date() } },
      );
    } catch (error) {
      console.log('❌ 贪吃蛇局面落库失败:', error);
    }
  }

  private toSnapshot(rt: Runtime): SnakeSnapshot {
    const state = rt.state;
    const now = Date.now();
    return {
      w: state.w,
      h: state.h,
      radius: SNAKE_RADIUS,
      tick: state.tick,
      variant: state.variant || 'team',
      players: state.snakes.map(s => ({
        id: s.id,
        nickname: rt.names.get(s.id) || '玩家',
        team: s.team || '',
      })),
      food: state.food.map(f => ({ x: f.x, y: f.y, r: f.r, v: f.v, k: f.k })),
      snakes: state.snakes.map(s => ({
        id: s.id,
        team: s.team || '',
        x: Math.round(s.x * 10) / 10,
        y: Math.round(s.y * 10) / 10,
        angle: Math.round(s.angle * 1000) / 1000,
        pts: snakeSpine(s),
        length: Math.round(s.length),
        alive: s.alive,
        score: s.score,
        best: Math.max(s.score || 0, s.best || 0),
        invincible: Math.max(0, (s.invincibleUntil || 0) - now),
        boosting: Math.max(0, (s.boostUntil || 0) - now),
        boostCd: Math.max(0, (s.boostReadyAt || 0) - now),
        magnet: Math.max(0, (s.magnetUntil || 0) - now),
        lightning: Math.max(0, (s.lightningUntil || 0) - now),
        respawnIn: 0,
        awaiting: !s.alive && (state.variant || 'team') === 'endless',
        respawns: s.respawns || 0,
      })),
      status: state.status,
      winner: state.winner,
      teamScores: state.teamScores || {},
    };
  }
}

export { SNAKE_BOOST_CD_MS };
export const snakeRuntimeService = new SnakeRuntimeService();
