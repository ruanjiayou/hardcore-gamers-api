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
  SNAKE_RADIUS,
  SNAKE_SEG_SPACING,
  SNAKE_TICK_MS,
  addSnake as addSnakeToState,
  createSnakeState,
  setBoost as setBoostState,
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
import { DEFAULT_SNAKE_PARAMS, resolveSnakeParams, type SnakeParams } from '../games/snake/params';
import { playerService } from './PlayerService';

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
  /** player_id -> 蛇皮肤 asset_id（玩家级选择，局中不查库，开局/加入时取一次） */
  skins: Map<string, string>;
  /**
   * 上一帧已下发的拾取物坐标表（id → 坐标）。
   * 用来算 foodAdd / foodDel（按 id）以及 foodMove（按坐标变化 —— 磁铁吸附会改坐标）。
   */
  foodPos: Map<number, { x: number; y: number }>;
  /** 置 1 表示下一帧必须发全量（开局/中途加入/周期对齐） */
  needFull: number;
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
  /**
   * 本局生效的可调参数（速度 / 加速 / 转向 / 体型）。
   * 客户端用它做本地预测 —— 与服务端权威必须是同一份数值，否则蛇会「拉丝」。
   */
  params?: SnakeParams;
  /** 座位表（id + 昵称 + 队伍 + 蛇皮肤），客户端据此显示玩家名与头顶标签 */
  players: { id: string; nickname: string; team: string; skin: string }[];
  /**
   * 拾取物全量（仅 `foodFull=true` 时下发）。
   * 平时用 `foodAdd` / `foodDel` 增量同步：100+ 个食物每 50ms 全量推一遍太浪费。
   */
  food?: SnakeFoodItem[];
  /** 本帧新增的拾取物（带稳定 id） */
  foodAdd?: SnakeFoodItem[];
  /** 本帧消失的拾取物 id */
  foodDel?: number[];
  /** 本帧坐标发生变化的拾取物（磁铁吸附会把食物往蛇头拉） */
  foodMove?: { id: number; x: number; y: number }[];
  /** 本帧的 `food` 是否为全量（开局首帧、中途加入、每 10s 对齐一次） */
  foodFull?: boolean;
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
    /** 剩余无敌时间（ms），0 表示没有（重生盾 + 星星共用） */
    invincible: number;
    /** 这一 tick 是否真的在加速（按住 + 身长够） */
    boosting: boolean;
    /** 加速键是否按住（客户端据此同步按钮状态） */
    boostHeld: boolean;
    /** 磁铁效果剩余时间（ms），0 表示没有 */
    magnet: number;
    /** 星星无敌剩余时间（ms），0 表示没有 */
    star: number;
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
  /** 团队模式还剩多少毫秒结束；0 = 不限时（无尽） */
  endsIn: number;
}

/** 拾取物的网络形态：只带渲染与判定需要的字段 */
function toFoodDTO(f: SnakeFoodItem) {
  // t（档位）随快照下发，客户端直接贴对应素材，不再按 radius 阈值反推
  return { id: f.id, x: f.x, y: f.y, r: f.r, v: f.v, k: f.k, t: f.t ?? 0 };
}

/** 判断运行时归属所需的最小信息 */
export interface RuntimeOwner {
  match_id: string;
  room_id: string;
}

/**
 * 同一房间只允许存在一个贪吃蛇运行时（纯函数，便于单测）。
 *
 * 背景：运行时是按 match_id 存内存的，而房间会换对局（match）。
 * 如果旧对局的运行时没被停掉，新对局又开了运行时，两个运行时就会同时往
 * 同一个 socket 频道 `room:<room_id>` 广播快照 —— 客户端一半的帧里找不到自己的蛇，
 * 于是「已出局」提示每 50ms 闪一次（SB-053）。
 *
 * 返回值：要停掉的旧运行时 match_id；null = 没有冲突。
 */
export function pickStaleRuntime(
  list: RuntimeOwner[],
  room_id: string,
  new_match_id: string,
): string | null {
  for (const rt of list) {
    if (rt.room_id !== room_id) continue;
    if (rt.match_id === new_match_id) continue;
    return rt.match_id;
  }
  return null;
}

/** 拾取物载荷：全量或增量 */
export interface SnakeFoodPayload {
  /** 全量表（仅 `foodFull=true` 时下发） */
  food?: SnakeFoodItem[];
  /** 增量：新增的拾取物 */
  foodAdd?: SnakeFoodItem[];
  /** 增量：消失的拾取物 id */
  foodDel?: number[];
  /**
   * 增量：坐标发生变化的拾取物（id + 新坐标）。
   *
   * 磁铁吸附会直接改食物的 x/y，而增删协议只带 id —— 客户端看到的食物纹丝不动，
   * 「吸的效果就没了」。这里补一个位移通道，客户端按 id 更新坐标。
   */
  foodMove?: { id: number; x: number; y: number }[];
  foodFull: boolean;
}

/**
 * 计算本帧的拾取物载荷（纯函数，便于单测）。
 *
 * - 全量：整表下发，客户端整表替换（开局首帧 / 中途加入 / 每 200 tick 对齐）。
 * - 增量：只发「上一帧没有的」「这一帧没了的」「坐标变了的」，客户端按 id 增删改。
 *
 * 关键点：**id 必须稳定**。客户端不按坐标猜拾取物，增删全靠 id，
 * 所以 id 复用（同一位置重新生成）时会出现「旧 id 还在 → 客户端不重画」。
 *
 * @param prev 上一帧的拾取物坐标表（id → 坐标），用来算增删与位移
 */
export function computeFoodPayload(
  prev: ReadonlyMap<number, { x: number; y: number }>,
  food: SnakeFoodItem[],
  full: boolean,
): SnakeFoodPayload {
  if (full) return { food: food.map(toFoodDTO), foodFull: true };
  const currentIds = new Set(food.map(f => f.id));
  const foodMove: { id: number; x: number; y: number }[] = [];
  for (const f of food) {
    const p = prev.get(f.id);
    // 上一帧没有的（新增）不在这里报位移 —— 它由 foodAdd 带着坐标下发
    if (!p) continue;
    if (p.x !== f.x || p.y !== f.y) foodMove.push({ id: f.id, x: f.x, y: f.y });
  }
  return {
    foodAdd: food.filter(f => !prev.has(f.id)).map(toFoodDTO),
    foodDel: [...prev.keys()].filter(id => !currentIds.has(id)),
    foodMove,
    foodFull: false,
  };
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

    // 一个房间只允许一个运行时：新对局开起来之前，先把同房间的旧运行时停掉。
    // 否则两个运行时会同时往同一个 socket 频道广播快照，客户端看到的是
    // 「两个不同对局的画面交替刷新」（自己那条蛇时有时无 → 已出局提示狂闪）。
    const stale = pickStaleRuntime([...this.runtimes.values()], match.room_id, match._id);
    if (stale) {
      this.stop(stale);
      // 旧对局在库里仍是 playing 的话一并收尾：留着会被 reconcileRoom /
      // cleanupZombieMatches 当成"进行中的对局"，房间的 match_id 会被拉回旧对局。
      void MMatch.updateOne(
        { _id: stale, status: constant.MATCH.STATUS.playing },
        { $set: { status: constant.MATCH.STATUS.gameover, updatedAt: new Date() } },
      ).catch((error: any) => console.log('❌ 清理同房间旧对局失败:', error));
      console.log(`🐍 房间 ${match.room_id} 已有旧运行时 ${stale}，已停掉（同一房间只留一个运行时）`);
    }

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

    // 本局冻结的参数：建局时写进 match.curr_state.params（见 RoomService.startGame）。
    // 老对局没有这个字段 → 用代码默认值。
    const params = resolveSnakeParams(match.curr_state?.params);

    const state = createSnakeState(ids, { variant, teams, random: Math.random, params });
    const names = new Map<string, string>();
    const skins = new Map<string, string>();
    for (const p of match.curr_state?.players || []) {
      if (!p?._id) continue;
      names.set(String(p._id), p.nickname || '玩家');
      if (p.skin) skins.set(String(p._id), String(p.skin));
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
      skins,
      foodPos: new Map(),
      needFull: 1,
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
      const players = await MPlayer.find({ _id: { $in: ids } }, { nickname: 1, skin: 1 }).lean(true);
      for (const p of players) {
        const name = (p as any)?.nickname;
        if (name) rt.names.set(String((p as any)._id), name);
        const skin = (p as any)?.skin;
        if (skin) rt.skins.set(String((p as any)._id), String(skin));
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

  /** 加速键按住状态（无 CD，代价是扣身长；服务端权威） */
  setBoost(match_id: string, player_id: string, held: boolean): boolean {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    const ok = setBoostState(rt.state, player_id, held);
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
  async addPlayer(match_id: string, player_id: string, nickname?: string, skin?: string): Promise<boolean> {
    const rt = this.runtimes.get(match_id);
    if (!rt) return false;
    if (nickname) rt.names.set(player_id, nickname);
    if (skin) rt.skins.set(player_id, skin);
    if (rt.state.snakes.some(s => s.id === player_id)) return true;
    const snake = addSnakeToState(rt.state, player_id, Math.random);
    snake.invincibleUntil = Date.now() + 3000;
    // 新玩家手上没有拾取物表，发一帧全量让所有人对齐（100 个食物几 KB，加入很低频）
    rt.needFull = 1;
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
        // 皮肤只记 asset_id：重启按 curr_state.players 重建运行时时直接可用，
        // 不用再去 player 表查一次（图由 manifest 预加载，快照里永远没有 URL）
        ...(rt.skins.get(player_id) ? { skin: rt.skins.get(player_id) } : {}),
      };
      // 内存基线：persist 会带上 players，服务端重启后 spawn 依赖它重建运行时
      const basePlayers: any[] = Array.isArray(rt.base?.players) ? rt.base.players : [];
      if (!basePlayers.some((p: any) => p._id === player_id)) {
        rt.base = { ...rt.base, players: [...basePlayers, memberSnapshot] };
      }
      // 先按 _id 清掉旧记录再追加：同一玩家反复进出/刷新会重复写入，
      // 对局里留下 N 条同 _id 记录，重启按 curr_state.players 重建运行时就会刷出多条幽灵蛇
      await MMatch.updateOne(
        { _id: rt.match_id },
        { $pull: { players: { _id: player_id }, 'curr_state.players': { _id: player_id } } } as any,
      );
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
    // 库里的对局成员也要跟着清：只删内存不删库，服务端一重启按 curr_state.players
    // 重建运行时就会给已经离场的人刷出一条幽灵蛇（别人看得见、撞得到，本人早退出了）
    const basePlayers: any[] = Array.isArray((rt.base as any)?.players) ? (rt.base as any).players : [];
    if (basePlayers.length) {
      rt.base = { ...rt.base, players: basePlayers.filter((p: any) => p._id !== player_id) } as any;
    }
    void MMatch.updateOne(
      { _id: rt.match_id },
      { $pull: { players: { _id: player_id }, 'curr_state.players': { _id: player_id } } } as any,
    ).catch(error => console.log('❌ 移出对局成员失败:', error));
    this.broadcast(rt);
    return true;
  }

  /** 实时快照（断线重进时给前端补齐到最新局面） */
  snapshot(match_id: string): SnakeSnapshot | null {
    const rt = this.runtimes.get(match_id);
    return rt ? this.toSnapshot(rt, { full: true }) : null;
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
      // 上榜成功 → 失效缓存，死亡弹框里的榜单当场就是新分数（SB-062）
      await playerService.invalidateLeaderboard(player_id, board);
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

  /**
   * 该房间是否还有活跃运行时。
   * 房间换对局前必须查一下：旧运行时没停干净就会和新运行时抢同一个广播频道。
   */
  hasByRoom(room_id: string): boolean {
    for (const rt of this.runtimes.values()) {
      if (rt.room_id === room_id) return true;
    }
    return false;
  }

  /**
   * 停掉某个房间的全部运行时（静默，不结算）。
   *
   * 房间被拨回等待态 / 对局被判结束时必须调用：否则运行时变成僵尸，
   * 还在 tick、还在往 `room:<id>` 广播快照，下一局开起来就变成两个运行时抢频道。
   */
  stopByRoom(room_id: string): number {
    let stopped = 0;
    for (const rt of [...this.runtimes.values()]) {
      if (rt.room_id !== room_id) continue;
      if (rt.timer) clearTimeout(rt.timer);
      this.runtimes.delete(rt.match_id);
      stopped++;
    }
    return stopped;
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
    // 每 200 tick（约 10s）对齐一次全量：偶发丢包/客户端增删错位也能自愈
    if (rt.state.tick % 200 === 0) rt.needFull = 1;
    this.io?.to(`room:${rt.room_id}`).emit('room:player-action', { snake: this.toSnapshot(rt) });
  }

  private async persist(rt: Runtime) {
    try {
      await MMatch.updateOne(
        { _id: rt.match_id },
        { $set: { curr_state: { ...rt.base, snake: this.toSnapshot(rt, { full: true }) }, updatedAt: new Date() } },
      );
    } catch (error) {
      console.log('❌ 贪吃蛇局面落库失败:', error);
    }
  }

  /**
   * 生成快照。
   * @param opts.full 强制全量（落库、手动取快照用）；否则按 `rt.needFull` 决定，
   *   平时只带 `foodAdd`/`foodDel`，把每帧体积从「100 个食物」压到「变化的那几个」。
   */
  private toSnapshot(rt: Runtime, opts: { full?: boolean } = {}): SnakeSnapshot {
    const state = rt.state;
    const now = Date.now();
    const food = state.food;
    const full = opts.full === true || rt.needFull > 0;
    const foodPayload = computeFoodPayload(rt.foodPos, food, full);
    // 本局冻结的参数（老对局没有则用代码默认值）
    const p = state.params || DEFAULT_SNAKE_PARAMS;
    // 记下本帧坐标，供下一帧算增删与位移
    rt.foodPos = new Map(food.map(f => [f.id, { x: f.x, y: f.y }]));
    rt.needFull = 0;
    return {
      w: state.w,
      h: state.h,
      radius: SNAKE_RADIUS,
      tick: state.tick,
      variant: state.variant || 'team',
      /**
       * 本局生效的可调参数：客户端用它做本地预测，
       * 保证与服务端权威用的是同一份数值（否则蛇会「拉丝」）。
       */
      params: state.params || DEFAULT_SNAKE_PARAMS,
      players: state.snakes.map(s => ({
        id: s.id,
        nickname: rt.names.get(s.id) || '玩家',
        team: s.team || '',
        skin: rt.skins.get(s.id) || '',
      })),
      // id 必须下发：客户端按 id 增删拾取物（不按坐标猜），增量同步全靠它
      ...foodPayload,
      snakes: state.snakes.map(s => ({
        id: s.id,
        team: s.team || '',
        x: Math.round(s.x * 10) / 10,
        y: Math.round(s.y * 10) / 10,
        angle: Math.round(s.angle * 1000) / 1000,
        pts: snakeSpine(s, SNAKE_SEG_SPACING, p.maxLength),
        length: Math.round(s.length),
        alive: s.alive,
        score: s.score,
        best: Math.max(s.score || 0, s.best || 0),
        invincible: Math.max(0, (s.invincibleUntil || 0) - now),
        boosting: s.boostHeld === true && s.length > p.boostMinLen && s.alive,
        boostHeld: s.boostHeld === true,
        magnet: Math.max(0, (s.magnetUntil || 0) - now),
        star: Math.max(0, (s.starUntil || 0) - now),
        respawnIn: 0,
        awaiting: !s.alive && (state.variant || 'team') === 'endless',
        respawns: s.respawns || 0,
      })),
      status: state.status,
      winner: state.winner,
      teamScores: state.teamScores || {},
      endsIn: Math.max(0, (state.endsAt || 0) - now),
    };
  }
}

export const snakeRuntimeService = new SnakeRuntimeService();
