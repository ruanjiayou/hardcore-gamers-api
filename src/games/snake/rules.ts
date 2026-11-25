/**
 * 贪吃蛇核心规则（纯函数，无 IO，可单测）。
 *
 * 连续像素世界（Slither 风格），**没有格子**：
 * - 蛇头是浮点坐标 + 朝向角，按速度连续前进；转向由服务端按最大角速度限制，
 *   所以玩家可以朝任意方向实时转向，而不是四方向跳格；
 * - 身体是蛇头走过的路径（稠密折线，步长 3px），按弧长截断，长度随吃食物增长；
 * - 碰撞是圆形：蛇头圆 vs 对方身体中心线（点—线段距离），因此"擦着过"不会误判，
 *   "真的压上去"必定判定；碰墙同样按半径算。
 * - 蛇头可以穿过自己的身体（自撞不死）：只有这样才敢贴着极小的圈盘旋。
 *   致命判定只来自"别人的蛇身"、"头对头"和"撞墙"。
 * - **谁撞谁死**：压到别人蛇身的一方独自承担（被撞的一方不死）；
 *   头对头只认"双方互相接近"的真对撞（同向并行/擦肩而过不算），
 *   对撞时按**身长**裁决：长的活、短的死，等长才双亡。这样"两条蛇碰一下就一起死"
 *   的闷亏基本消失，同时保留"以大打小"的对抗感。
 *
 * 两种玩法共用同一套规则：
 * - 无尽挑战（variant=endless，房间制，1–10 人共享同一片地图）：
 *   死亡不会结束对局，停在"已出局"等玩家选择（重生 / 退出）；点重生后在空白处随机复活并带 3s 无敌。
 *   分数按"单条命最高分"记榜，死亡的瞬间就会结算进排行榜。
 * - 团队模式（variant=team，房间制，最多 6 队 × 每队 5 人）：
 *   队友之间不会互相碰撞致死（同队豁免），可以互相掩护；
 *   一支队伍全员出局即被淘汰，只剩一支队伍时该队获胜。
 *
 * 场上可拾取物（state.food）统一成一个数组，用 kind 区分：
 *   普通食物（分三档：小的多、大的少）/ 尸体残骸 / 道具（磁铁、星星）。
 * 道具是**注册表**（SNAKE_ITEM_DEFS）驱动的，加新道具只往数组里加一项。
 *
 * 常量与判定顺序的唯一来源是《贪吃蛇大作战 规则规格》，改动前先改规格文档。
 */

import { DEFAULT_SNAKE_PARAMS, type SnakeParams } from './params';

export type SnakeVariant = 'endless' | 'team';

/** 世界尺寸（像素）：远大于视口，镜头跟随主角 */
export const SNAKE_WORLD_W = 4800;
export const SNAKE_WORLD_H = 3400;
/** 场上同时存在的普通食物数量 */
export const SNAKE_FOOD_COUNT = 100;
/** 场上同时存在的道具数量 */
export const SNAKE_ITEM_COUNT = 8;
/**
 * 食物分档：小食物数量多、大食物数量少。
 * - radius 决定视觉大小与碰撞判定；
 * - value 决定收益（同时按比例决定身体增长，见 SNAKE_GROW_PER_SCORE）；
 * - weight 是抽取权重：60 / 28 / 12（期望单颗价值 ≈ 12.96）。
 */
export const SNAKE_FOOD_TIERS = [
  { radius: 6, value: 6, weight: 60 },
  { radius: 12, value: 18, weight: 28 },
  { radius: 18, value: 36, weight: 12 },
] as const;
/** 最小档（小食物）的分值 */
export const SNAKE_FOOD_SCORE = SNAKE_FOOD_TIERS[0].value;
/** 每 1 分值增长的身体像素 */
export const SNAKE_GROW_PER_SCORE = 3;

/**
 * 场上可拾取物的类型（用数字而非字符串：快照每帧广播，体积越小越好）。
 * 客户端与 AI 侧各自镜像一份同名常量；道具 kind 由 SNAKE_ITEM_DEFS 分配（从 2 起）。
 */
export const SNAKE_KIND_FOOD = 0;   // 普通食物
export const SNAKE_KIND_CORPSE = 1; // 尸体残骸

/** 一个可拾取物（食物 / 残骸 / 道具） */
export interface SnakeFoodItem {
  /** 稳定自增 id：增量广播与删除依赖它（客户端按 id 增删，不按坐标猜） */
  id: number;
  x: number;
  y: number;
  /** 半径（像素）：决定碰撞判定与绘制大小 */
  r: number;
  /** 分值：吃到后增加的分数；道具为 0 */
  v: number;
  /** 类型：0 食物 / 1 残骸 / ≥2 道具（见 SNAKE_ITEM_DEFS） */
  k: number;
}

/**
 * 道具注册表。**加新道具只往这里加一项**，不要在各处写 `if (kind === xxx)`：
 * - kind：广播/快照里的稳定类型号，一旦上线不要再改（客户端按它取皮肤）；
 * - key：资源系统里的皮肤 key（资源包 `games[game].skins.items[key]`，见 GM-snake-25）；
 * - weight：抽取权重；radius：半径；durationMs：效果持续时长。
 *
 * 现有两种：
 * - magnet 磁铁：把蛇头 220px 内的非道具可拾取物以 300px/s 拉过来；
 * - star 星星：获得无敌（免疫别人身体与头对头，**不免撞墙**）。
 * 效果都是"刷新式"：再吃一个把剩余时间重置为完整时长，不叠加。
 */
export interface SnakeItemDef {
  kind: number;
  key: string;
  label: string;
  weight: number;
  radius: number;
  durationMs: number;
}
export const SNAKE_ITEM_DEFS: SnakeItemDef[] = [
  { kind: 2, key: 'magnet', label: '磁铁', weight: 50, radius: 11, durationMs: 6000 },
  { kind: 3, key: 'star', label: '星星', weight: 50, radius: 11, durationMs: 2500 },
];
/** kind -> 定义（吃判定与皮肤查找都走它，避免散落的 if 分支） */
export const SNAKE_ITEM_BY_KIND: Record<number, SnakeItemDef> = Object.fromEntries(
  SNAKE_ITEM_DEFS.map(d => [d.kind, d]),
);
/** 道具半径（默认档；单个道具可在注册表里覆盖） */
export const SNAKE_ITEM_RADIUS = SNAKE_ITEM_DEFS[0].radius;
export const SNAKE_KIND_MAGNET = 2;
export const SNAKE_KIND_STAR = 3;

export const SNAKE_MAGNET_RADIUS = 220;
export const SNAKE_MAGNET_PULL = 300;

/**
 * 尸体残骸：蛇死后沿身体留下一串可被吃的残骸。
 * - 数量随身长增长（每 SNAKE_CORPSE_PER_LENGTH 像素一颗，单次上下限约束）；
 * - 单颗价值 = 死亡时分数 × SNAKE_CORPSE_RATIO ÷ 数量 → 越大越值钱，但单颗封顶；
 * - 场上残骸有数量与总价值双上限，防止多人同时死亡把世界堆成雪球。
 *
 * 能量为什么收敛（这是"系数必须 < 1"的根本原因）：
 * 蛇死亡时，分数从"这条蛇身上"转移到"场上的残骸"，总价值只有原来的 ρ 倍
 * （ρ = SNAKE_CORPSE_RATIO = 0.9），也就是说**每次死亡都会净损失 (1-ρ) 的分数**。
 * 残骸被别的蛇吃掉 → 变成那条蛇的分数 → 它再死 → 又只剩 ρ 倍……
 * 于是"分数 → 残骸 → 分数"每一代衰减 (1-ρ)，几何级数收敛：
 *   一条蛇最终能释放到世界上的总残骸价值 ≤ score × ρ/(1-ρ) = 9 × score。
 * 系数必须 ≤ 1：ρ = 1 时每一代都不衰减，残骸可以被无限"复制"（指数发散）；
 * ρ > 1 更是直接爆炸。ρ = 0.9 时放大 9 倍；想更保守就调小：
 * ρ = 0.7 → 2.3 倍；ρ = 0.5 → 1 倍（完全不放大，纯转移）。
 */
export const SNAKE_CORPSE_RATIO = 0.9;
export const SNAKE_CORPSE_PER_LENGTH = 30;
export const SNAKE_CORPSE_MIN = 4;
export const SNAKE_CORPSE_MAX = 64;
/** 单颗残骸的价值上限 */
export const SNAKE_CORPSE_VALUE_MAX = 45;
/** 场上残骸的总价值上限（世界总能量的硬顶） */
export const SNAKE_CORPSE_FIELD_CAP = 3600;
/** 场上残骸的数量上限（同时也是快照体积的保护） */
export const SNAKE_CORPSE_FIELD_MAX = 80;

/** 推进间隔（毫秒）：20Hz，客户端负责插值成 60fps */
export const SNAKE_TICK_MS = 50;

/** 蛇身半径 / 蛇头半径（像素） */
export const SNAKE_RADIUS = 15;
export const SNAKE_HEAD_RADIUS = 16;
/**
 * 速度模型：**巡航速度随身长线性递减**（贪吃蛇大作战的核心手感）。
 *
 * 「刚出生的小蛇跑得快，体型越肥跑得越慢」—— 肥蛇慢下来的同时角速度也自动跟着降
 * （ω = v / R，R 固定），于是长蛇又慢又难转向，规避操作变难、收益变高，
 * 形成「吃得多 = 灵活度下降」的取舍。单条命越长越难跑，这正是原作的策略纵深。
 *
 * 线性插值：身长 bodyLength → speedMax，身长 maxLength → speedMin。
 *
 * ⚠️ 这些值**可被数据库覆盖**（运营在管理端改 `games.config`，下一局生效），
 * 详见 `params.ts`。下面的常量只是**代码默认值**的别名，真实值由对局的
 * `params` 决定 —— 客户端也从服务端快照读同一份，两端永远一致。
 */
export const SNAKE_SPEED_MAX = DEFAULT_SNAKE_PARAMS.speedMax;
export const SNAKE_SPEED_MIN = DEFAULT_SNAKE_PARAMS.speedMin;
/**
 * 加速倍率：加速速度 = 当前巡航速度 × 本倍率。
 * 不再写死「加速后的绝对速度」—— 巡航速度已经随身长变化，写死绝对值会让长蛇加速
 * 变成 5 倍速的荒谬手感。倍率恒定才符合直觉：加速永远是「快一点」，不是「飞」。
 */
export const SNAKE_BOOST_MULT = DEFAULT_SNAKE_PARAMS.boostMult;
/**
 * 最小转弯半径（像素）：手感用"能拐多小的弯"描述，角速度由 ω = v / R 推导。
 * 半径固定 → 速度越慢角速度越小 → 长蛇转向更迟钝（与速度曲线叠加，手感一致）。
 */
export const SNAKE_MIN_TURN_RADIUS = DEFAULT_SNAKE_PARAMS.turnRadius;
export const SNAKE_BOOST_MIN_TURN_RADIUS = DEFAULT_SNAKE_PARAMS.boostTurnRadius;

/** 初始身长 / 上限（像素） */
export const SNAKE_BODY_LENGTH = DEFAULT_SNAKE_PARAMS.bodyLength;
export const SNAKE_MAX_LENGTH = DEFAULT_SNAKE_PARAMS.maxLength;

/**
 * 巡航速度（像素/秒）：按身长线性插值。
 * 身长 = 初始长度 → speedMax（最快）；身长 = 上限 → speedMin（最慢）。
 *
 * @param params 本局的参数（来自对局状态，可被数据库配置覆盖）。
 *               缺省用代码默认值 —— 单测与旧调用方不需要额外准备。
 *
 * 客户端与 AI 侧必须镜像同一个公式（否则本地预测与服务端权威值漂移，蛇会「拉丝」），
 * 所以客户端拿到的也是服务端下发的同一份 params。
 */
export function snakeCruiseSpeed(length: number, params?: SnakeParams): number {
  const p = params || DEFAULT_SNAKE_PARAMS;
  const len = Math.max(0, length || 0);
  const span = Math.max(1, p.maxLength - p.bodyLength);
  const t = Math.min(1, Math.max(0, (len - p.bodyLength) / span));
  return p.speedMax + (p.speedMin - p.speedMax) * t;
}

/** 当前身长下的实际移动速度（加速时 = 巡航 × 倍率） */
export function snakeMoveSpeed(length: number, boosting: boolean, params?: SnakeParams): number {
  const p = params || DEFAULT_SNAKE_PARAMS;
  return snakeCruiseSpeed(length, p) * (boosting ? p.boostMult : 1);
}

/** 当前身长下的转向角速度（rad/s）：ω = v / R，R 固定 → 速度越慢转得越迟钝 */
export function snakeTurnRate(length: number, boosting: boolean, params?: SnakeParams): number {
  const p = params || DEFAULT_SNAKE_PARAMS;
  const r = boosting ? p.boostTurnRadius : p.turnRadius;
  return snakeMoveSpeed(length, boosting, p) / Math.max(1, r);
}

/**
 * 加速：**按住生效，无 CD、无时长上限**，代价是从尾部扣身长。
 * - BOOST_DRAIN：每秒扣除的身长像素；
 * - BOOST_MIN_LEN：低于此长度无法加速，加速中也扣不到它以下。
 * 加速不扣分、不影响分数；吃食物可恢复长度。
 */
export const SNAKE_BOOST_DRAIN = DEFAULT_SNAKE_PARAMS.boostDrain;
export const SNAKE_BOOST_MIN_LEN = DEFAULT_SNAKE_PARAMS.boostMinLen;
/** 重生无敌时间（毫秒）。死亡后由玩家点「重生」才复活，不自动重生 */
export const SNAKE_INVINCIBLE_MS = 3000;

/** 团队模式限时（毫秒）：8 分钟，时间到按团队总分判胜 */
export const SNAKE_TEAM_MATCH_MS = 480_000;
/** 团队"先到目标分即胜"，0 = 关闭（只按时间与存活判） */
export const SNAKE_TEAM_TARGET_SCORE = 0;

/** 内部路径采样步长（像素）：越小身体曲线越顺，越大内存/CPU 越省 */
export const SNAKE_PATH_STEP = 3;
/** 发给客户端的身体采样间距（像素）：按弧长等距，index 与身长一一对应，便于插值 */
export const SNAKE_SEG_SPACING = 22;
/** 碰撞判定半径：头圆 + 身体半径（略微宽容一点，避免"看着没碰到却死"） */
const SNAKE_HIT_R = SNAKE_HEAD_RADIUS + SNAKE_RADIUS * 0.8;
const SNAKE_HIT_R2 = SNAKE_HIT_R * SNAKE_HIT_R;

const TAU = Math.PI * 2;

export interface SnakePlayerState {
  id: string;
  /** 蛇头坐标（像素，浮点） */
  x: number;
  y: number;
  /** 当前朝向（弧度，0 = +x，顺时针为正，因为 y 轴向下） */
  angle: number;
  /** 玩家期望的朝向（服务端按最大角速度追过去） */
  targetAngle: number;
  /** 走过的路径，[0] 是蛇头，步长约 SNAKE_PATH_STEP */
  path: [number, number][];
  /** 身长（像素）：路径超过这个长度就截断 */
  length: number;
  alive: boolean;
  /** 当前这条命的分数（重生后清零） */
  score: number;
  /** 本局历史最高分（跨重生，用于无尽榜与 HUD） */
  best: number;
  /** 无敌截止时间戳（ms）：无敌期间不结算别人蛇身的碰撞（撞自己本来就不死，撞墙照常死） */
  invincibleUntil: number;
  /** 加速按钮是否按住（每 tick 可更新）；真正生效还要看身长是否够 */
  boostHeld: boolean;
  /** 磁铁效果截止时间戳（ms）：期间自动吸附附近食物 */
  magnetUntil: number;
  /** 星星效果截止时间戳（ms）：期间免疫别人身体与头对头（不免撞墙） */
  starUntil: number;
  /** 无尽模式：可重生时间戳（ms） */
  respawnAt: number;
  /** 重生次数（HUD 展示用） */
  respawns: number;
  /** 所属队伍（团队模式）；空串表示无队伍 */
  team: string;
}

export interface SnakeState {
  /** 世界宽高（像素） */
  w: number;
  h: number;
  tick: number;
  /** 场上可拾取物（普通食物 / 尸体残骸 / 道具） */
  food: SnakeFoodItem[];
  snakes: SnakePlayerState[];
  status: 'playing' | 'over';
  /** 胜者 player_id；'' 表示平局 */
  winner: string;
  /** 玩法；缺省按多人对战处理（兼容旧对局数据） */
  variant: SnakeVariant;
  /** 团队模式下各队总积分：team -> 累计分数 */
  teamScores?: Record<string, number>;
  /** 团队模式结束时间戳（ms）；0 = 不限时（无尽模式） */
  endsAt: number;
  /** 可拾取物自增 id（快照增量与客户端删除依赖它） */
  nextItemId: number;
  /**
   * 本局生效的可调参数（速度 / 转向 / 体型）。
   *
   * **建局时冻结**：整局不变，中途改数据库配置不影响进行中的对局。
   * 客户端从快照里读同一份，保证预测公式与服务端权威完全一致。
   */
  params?: SnakeParams;
}

export interface SnakeStepResult {
  /** 本 tick 淘汰的蛇 */
  died: string[];
  /** 本 tick 吃到东西的蛇 */
  ate: string[];
  /** 本 tick 重生的蛇 */
  respawned: string[];
  over: boolean;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

/** 归一化到 [0, 2π) */
export function normalizeAngle(a: number): number {
  let r = a % TAU;
  if (r < 0) r += TAU;
  return r;
}

/** 按最短方向把 cur 转向 target，一次最多转 maxDelta 弧度 */
export function turnToward(cur: number, target: number, maxDelta: number): number {
  if (!Number.isFinite(target)) return normalizeAngle(cur);
  let diff = normalizeAngle(target - cur);
  if (diff > Math.PI) diff -= TAU; // 取最短那一侧（-π, π]
  if (Math.abs(diff) <= maxDelta) return normalizeAngle(target);
  return normalizeAngle(cur + Math.sign(diff) * maxDelta);
}

export const isSnakeVariant = (v: unknown): v is SnakeVariant => v === 'endless' || v === 'team';
export const isSnakeAngle = (a: unknown): a is number => typeof a === 'number' && Number.isFinite(a);

/** 点到线段距离的平方（碰撞用；线段是这一 tick 蛇头扫过的轨迹） */
function pointSegDist2(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 1e-9 ? (wx * vx + wy * vy) / len2 : 0;
  t = clamp(t, 0, 1);
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 价值 → 外观半径（普通食物与残骸共用同一套映射） */
export function snakeRadiusForValue(v: number): number {
  if (v >= 20) return SNAKE_FOOD_TIERS[2].radius;
  if (v >= 8) return SNAKE_FOOD_TIERS[1].radius;
  return SNAKE_FOOD_TIERS[0].radius;
}

/** 按权重抽一个食物档位 */
function pickTier(random: () => number) {
  const total = SNAKE_FOOD_TIERS.reduce((a, t) => a + t.weight, 0);
  let r = random() * total;
  for (const t of SNAKE_FOOD_TIERS) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return SNAKE_FOOD_TIERS[0];
}

/** 按权重抽一种道具（注册表驱动：加新道具自动参与抽取） */
function pickItemDef(random: () => number): SnakeItemDef {
  const total = SNAKE_ITEM_DEFS.reduce((a, d) => a + d.weight, 0);
  let r = random() * total;
  for (const d of SNAKE_ITEM_DEFS) {
    r -= d.weight;
    if (r <= 0) return d;
  }
  return SNAKE_ITEM_DEFS[0];
}

const nextId = (state: SnakeState) => state.nextItemId++;

/** 随机撒一颗普通食物（分档）；连续失败就放弃（场上食物略少也不影响可玩性） */
export function spawnFood(state: SnakeState, random: () => number = Math.random): SnakeFoodItem | null {
  const margin = 50;
  const tier = pickTier(random);
  for (let i = 0; i < 80; i++) {
    const x = margin + random() * (state.w - margin * 2);
    const y = margin + random() * (state.h - margin * 2);
    if (nearSnake(state, x, y, 90)) continue;
    if (state.food.some(f => dist(f.x, f.y, x, y) < 70)) continue;
    const item: SnakeFoodItem = {
      id: nextId(state),
      x: round1(x),
      y: round1(y),
      r: tier.radius,
      v: tier.value,
      k: SNAKE_KIND_FOOD,
    };
    state.food.push(item);
    return item;
  }
  return null;
}

/** 随机撒一个道具；道具不加长度也不加分 */
export function spawnItem(state: SnakeState, random: () => number = Math.random): SnakeFoodItem | null {
  const margin = 70;
  const def = pickItemDef(random);
  for (let i = 0; i < 80; i++) {
    const x = margin + random() * (state.w - margin * 2);
    const y = margin + random() * (state.h - margin * 2);
    if (nearSnake(state, x, y, 110)) continue;
    if (state.food.some(f => dist(f.x, f.y, x, y) < 90)) continue;
    const item: SnakeFoodItem = {
      id: nextId(state),
      x: round1(x),
      y: round1(y),
      r: def.radius,
      v: 0,
      k: def.kind,
    };
    state.food.push(item);
    return item;
  }
  return null;
}

/** 该点是否离任何蛇身/蛇头太近（出生点与食物都用它避让） */
function nearSnake(state: SnakeState, x: number, y: number, radius: number): boolean {
  const r2 = radius * radius;
  for (const s of state.snakes) {
    if (!s.alive) continue;
    if (dist(s.x, s.y, x, y) ** 2 < r2) return true;
    const path = s.path;
    for (let i = 0; i < path.length; i += 3) {
      const dx = path[i][0] - x;
      const dy = path[i][1] - y;
      if (dx * dx + dy * dy < r2) return true;
    }
  }
  return false;
}

/** 生成一条朝 angle 方向、笔直向后铺开的初始路径（末端精确到 length） */
function straightPath(x: number, y: number, angle: number, length: number): [number, number][] {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const path: [number, number][] = [];
  const n = Math.max(1, Math.ceil(length / SNAKE_PATH_STEP));
  for (let i = 0; i <= n; i++) {
    const d = Math.min(length, i * SNAKE_PATH_STEP);
    path.push([x - dx * d, y - dy * d]);
  }
  return path;
}

/**
 * 找一个能放蛇的空位：离墙留出跑道（不然不发输入就会撞墙）、离别的蛇留出安全距离。
 * 失败时退化为"只在世界中央区域随机"，保证一定生得出来。
 */
function randomSpawn(
  state: SnakeState,
  random: () => number,
): { x: number; y: number; angle: number } {
  const margin = 200;
  const centerAngle = (x: number, y: number) => Math.atan2(state.h / 2 - y, state.w / 2 - x);
  for (let i = 0; i < 120; i++) {
    const x = margin + random() * (state.w - margin * 2);
    const y = margin + random() * (state.h - margin * 2);
    // 朝地图中心出生（±0.5 弧度抖动）：保证面前有足够长的跑道，
    // 否则"进房不动几秒就撞墙"看起来像 bug
    const angle = centerAngle(x, y) + (random() - 0.5);
    if (nearSnake(state, x, y, 160)) continue;
    return { x, y, angle };
  }
  return {
    x: state.w / 2 + (random() - 0.5) * state.w * 0.5,
    y: state.h / 2 + (random() - 0.5) * state.h * 0.5,
    angle: random() * TAU,
  };
}

function newSnake(id: string, x: number, y: number, angle: number, team = '', bodyLength = SNAKE_BODY_LENGTH): SnakePlayerState {
  return {
    id,
    x,
    y,
    angle: normalizeAngle(angle),
    targetAngle: normalizeAngle(angle),
    path: straightPath(x, y, angle, bodyLength),
    length: bodyLength,
    alive: true,
    score: 0,
    best: 0,
    invincibleUntil: 0,
    boostHeld: false,
    magnetUntil: 0,
    starUntil: 0,
    respawnAt: 0,
    respawns: 0,
    team,
  };
}

export interface CreateSnakeOptions {
  width?: number;
  height?: number;
  foodCount?: number;
  itemCount?: number;
  random?: () => number;
  variant?: SnakeVariant;
  /** 玩家 -> 队伍（团队模式） */
  teams?: Record<string, string>;
  /**
   * 本局生效的可调参数（建局时由服务端从数据库配置解析并冻结）。
   * 缺省用代码默认值。
   */
  params?: SnakeParams;
}

/**
 * 建局：每条蛇随机撒在空白处（同一片地图一起玩）。
 * 多人对战也复用同一套随机出生——像素世界没有"中线对开"的格子概念。
 */
export function createSnakeState(playerIds: string[], opts: CreateSnakeOptions = {}): SnakeState {
  const {
    width = SNAKE_WORLD_W,
    height = SNAKE_WORLD_H,
    foodCount = SNAKE_FOOD_COUNT,
    itemCount = SNAKE_ITEM_COUNT,
    random = Math.random,
    // 规格 §9.3：variant 必须显式传参，缺省按无尽模式
    variant = 'endless',
    teams = {},
    params,
  } = opts;

  // 参数在建局这一刻冻结：整局不变，客户端也从快照读同一份。
  // **复制一份**（不是存引用）—— 否则调用方后续改动配置对象会污染已建的对局，
  // 「建局时冻结」的保证就破了。
  const p: SnakeParams = { ...(params || DEFAULT_SNAKE_PARAMS) };

  const state: SnakeState = {
    w: width,
    h: height,
    tick: 0,
    food: [],
    snakes: [],
    status: 'playing',
    winner: '',
    variant,
    // 团队模式限时 8 分钟；无尽模式不限时（对局永不结束）
    endsAt: variant === 'team' ? Date.now() + SNAKE_TEAM_MATCH_MS : 0,
    nextItemId: 1,
    params: p,
  };

  for (const id of playerIds) addSnake(state, id, random, teams[id] || '');
  for (let i = 0; i < foodCount; i++) spawnFood(state, random);
  for (let i = 0; i < itemCount; i++) spawnItem(state, random);
  return state;
}

/** 在现有局面里加一条蛇（开局 / 中途加入 / 重连补位都走它，保证避开场上已有的蛇） */
export function addSnake(state: SnakeState, id: string, random: () => number = Math.random, team = ''): SnakePlayerState {
  const spot = randomSpawn(state, random);
  const snake = newSnake(id, spot.x, spot.y, spot.angle, team, (state.params || DEFAULT_SNAKE_PARAMS).bodyLength);
  state.snakes.push(snake);
  return snake;
}

/**
 * 转向指令：记下期望朝向即可（任意角度）。
 * 真正的转向速度由 stepSnake 按 SNAKE_TURN_RATE 限制，所以这里不做"反向/同向"拒绝。
 */
export function steerSnake(state: SnakeState, playerId: string, angle: number): boolean {
  if (state.status !== 'playing') return false;
  if (!isSnakeAngle(angle)) return false;
  const snake = state.snakes.find(s => s.id === playerId);
  if (!snake || !snake.alive) return false;
  snake.targetAngle = normalizeAngle(angle);
  return true;
}

/**
 * 加速按钮的按住状态（每 tick 可更新，无 CD、无时长上限）。
 * 真正是否加速由 stepSnake 判断：`boostHeld && length > boostMinLen`（取本局参数）。
 */
export function setBoost(state: SnakeState, playerId: string, held: boolean): boolean {
  if (state.status !== 'playing') return false;
  const snake = state.snakes.find(s => s.id === playerId);
  if (!snake || !snake.alive) return false;
  snake.boostHeld = held === true;
  return true;
}

/** 无尽模式重生：随机空白位置、初始身长、3s 无敌；本条命分数归零，best 保留 */
export function respawnSnake(
  state: SnakeState,
  playerId: string,
  now: number = Date.now(),
  random: () => number = Math.random,
): boolean {
  const snake = state.snakes.find(s => s.id === playerId);
  if (!snake || snake.alive) return false;
  const spot = randomSpawn(state, random);
  const bodyLength = (state.params || DEFAULT_SNAKE_PARAMS).bodyLength;
  snake.x = spot.x;
  snake.y = spot.y;
  snake.angle = normalizeAngle(spot.angle);
  snake.targetAngle = snake.angle;
  snake.path = straightPath(spot.x, spot.y, snake.angle, bodyLength);
  snake.length = bodyLength;
  snake.alive = true;
  snake.score = 0;
  snake.respawnAt = 0;
  snake.respawns = (snake.respawns || 0) + 1;
  snake.invincibleUntil = now + SNAKE_INVINCIBLE_MS;
  snake.boostHeld = false;
  snake.magnetUntil = 0;
  snake.starUntil = 0;
  return true;
}

/** 把这一 tick 的位移写进路径（head 在最前），并保证采样密度 */
function pushPath(s: SnakePlayerState, fromX: number, fromY: number) {
  const dx = s.x - fromX;
  const dy = s.y - fromY;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  const n = Math.max(1, Math.ceil(d / SNAKE_PATH_STEP));
  const insert: [number, number][] = [];
  for (let i = n; i >= 1; i--) insert.push([fromX + (dx * i) / n, fromY + (dy * i) / n]);
  s.path.unshift(...insert);
}

/** 按身长截断路径（尾巴是插值出来的精确端点） */
function truncatePath(s: SnakePlayerState) {
  const path = s.path;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = dist(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (acc + seg >= s.length) {
      const t = seg > 1e-6 ? (s.length - acc) / seg : 0;
      path[i] = [
        path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
        path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
      ];
      path.length = i + 1;
      return;
    }
    acc += seg;
  }
}

interface Move {
  s: SnakePlayerState;
  angle: number;
  ox: number;
  oy: number;
  nx: number;
  ny: number;
  /** 这一 tick 是否真的在加速（按住 + 身长够） */
  boosting: boolean;
}

/**
 * 撞身体：蛇头这一 tick 扫过的线段到对方身体中心线的距离。自己的蛇身不参与判定。
 * 团队模式下同队成员之间不互相碰撞（队友可以互相掩护）。
 *
 * 对方**蛇头附近**（弧长 < 2×HEAD_RADIUS 的一段）不参与判定：那段该交给头对头裁决。
 * 否则 HIT_R(28) 大于头对头触发距离(32)的一半，正面对撞会先被"撞身体"判死，
 * 身长/护盾根本没机会参与，规格 §6.C 的"长者活、短者死"永远触发不了。
 */
function hitsBody(state: SnakeState, m: Move, now: number): boolean {
  // 无敌（重生盾 / 星星）只免疫别人的身体；撞自己本来就没事，撞墙照常死
  if ((m.s.invincibleUntil || 0) > now) return false;
  const headGuard = SNAKE_HEAD_RADIUS * 2;
  for (const other of state.snakes) {
    if (!other.alive || other === m.s) continue;
    // 同队豁免：队友撞到队友不算死
    if (m.s.team && other.team === m.s.team) continue;
    const path = other.path;
    let acc = 0;
    for (let i = 2; i < path.length; i += 2) {
      acc += dist(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
      if (acc < headGuard) continue;
      if (pointSegDist2(path[i][0], path[i][1], m.ox, m.oy, m.nx, m.ny) < SNAKE_HIT_R2) return true;
    }
  }
  return false;
}

/**
 * 这一 tick 里两条蛇是否在互相靠近（两人间距在缩小）。
 * 头对头只在这种"真对撞"时成立：同向并排跑、擦肩而过、已经被对方甩在身后都不算。
 * 用移动**前**的位置做基准 —— 用移动后的位置会出现"已经交叉过去了"从而判定远离的误判。
 */
function approaching(a: Move, b: Move): boolean {
  const rvx = (b.nx - b.ox) - (a.nx - a.ox);
  const rvy = (b.ny - b.oy) - (a.ny - a.oy);
  const dx = b.ox - a.ox;
  const dy = b.oy - a.oy;
  if (dx * dx + dy * dy > 1e-6) return rvx * dx + rvy * dy < 0;
  // 上一 tick 就贴在一起了：退回用移动后的连线判断
  const nx = b.nx - a.nx;
  const ny = b.ny - a.ny;
  const nd = Math.hypot(nx, ny);
  if (nd < 1e-6) return true;
  return (rvx * nx + rvy * ny) / nd < 0;
}

/**
 * 磁铁：把蛇头一定半径内的食物拉向蛇头（道具本身不吸）。
 * 拉过来的食物下一 tick 就会被判定吃掉 —— 这是"自动收菜"的手感来源。
 */
function applyMagnet(state: SnakeState, now: number, dt: number) {
  const pull = SNAKE_MAGNET_PULL * dt;
  for (const s of state.snakes) {
    if (!s.alive) continue;
    if ((s.magnetUntil || 0) <= now) continue;
    for (const f of state.food) {
      // 道具不吸（k >= 2），食物与残骸都吸
      if (f.k !== SNAKE_KIND_FOOD && f.k !== SNAKE_KIND_CORPSE) continue;
      const dx = s.x - f.x;
      const dy = s.y - f.y;
      const d = Math.hypot(dx, dy);
      if (d > SNAKE_MAGNET_RADIUS || d < 1e-6) continue;
      const step = Math.min(pull, d);
      f.x = round1(f.x + (dx / d) * step);
      f.y = round1(f.y + (dy / d) * step);
    }
  }
}

/**
 * 蛇死亡 → 沿身体留下一串残骸。
 * - 数量：随身长增长（SNAKE_CORPSE_PER_LENGTH 像素一颗，上下限约束）；
 * - 价值：单颗 = 死亡分数 × SNAKE_CORPSE_RATIO ÷ 数量（越大越值钱，单颗封顶）；
 * - 上限：场上残骸数量与总价值都有硬顶，多人同时死亡也不会把世界堆成雪球。
 */
function dropCorpses(state: SnakeState, s: SnakePlayerState) {
  // 满场替换：场上数量/价值已顶格时，先移除最低价值的残骸腾位置（最多 15 颗或 25%），
  // 移除即销毁 —— 等价于额外衰减，保证"残骸总量永不突破硬顶"。
  const tryDrop = () => dropCorpsesOnce(state, s);
  if (tryDrop() !== 'full') return;
  const corpses = state.food.filter(f => f.k === SNAKE_KIND_CORPSE);
  const removeMax = Math.min(15, Math.ceil(corpses.length * 0.25));
  if (removeMax <= 0) return;
  corpses.sort((a, b) => a.v - b.v);
  const victims = new Set(corpses.slice(0, removeMax).map(f => f.id));
  state.food = state.food.filter(f => !victims.has(f.id));
  if (tryDrop() !== 'ok') {
    // 腾完还是放不下：放弃本次掉落（只记日志，不抛错）
    console.log(`⚠️ 残骸掉落放弃：player=${s.id} score=${s.score}`);
  }
}

/** 返回 'ok' 成功 / 'full' 场上顶格 / 'empty' 无分可掉 */
function dropCorpsesOnce(state: SnakeState, s: SnakePlayerState): 'ok' | 'full' | 'empty' {
  const score = Math.max(0, Math.floor(s.score || 0));
  // 目标总价值：死亡分数的 ρ 倍（向下取整，保证"残骸总价值 ≤ score × ρ"严格成立）
  const targetTotal = Math.floor(score * SNAKE_CORPSE_RATIO);
  if (targetTotal <= 0) return 'empty';

  // 场上已有的残骸：数量与总价值都要留出余量
  let onField = 0;
  let valueOnField = 0;
  for (const f of state.food) {
    if (f.k !== SNAKE_KIND_CORPSE) continue;
    onField++;
    valueOnField += f.v;
  }

  // 数量随身长增长（越大尸体越多）
  let count = clamp(
    Math.round((s.length || 0) / SNAKE_CORPSE_PER_LENGTH),
    SNAKE_CORPSE_MIN,
    SNAKE_CORPSE_MAX,
  );
  count = Math.min(count, SNAKE_CORPSE_FIELD_MAX - onField);
  if (count <= 0) return 'full';

  // 单颗价值：均摊，单颗封顶；场上总价值还有硬顶
  let per = Math.min(Math.floor(targetTotal / count), SNAKE_CORPSE_VALUE_MAX);
  per = Math.min(per, Math.floor((SNAKE_CORPSE_FIELD_CAP - valueOnField) / count));
  if (per < 1) return 'full';

  // 余数补给前几颗：让残骸总价值尽量贴近 score × ρ（且绝不超过）
  const remainder = Math.min(targetTotal - per * count, count - per);

  // 沿身体摆放：蛇头在 path[0]，尾巴在末尾
  const spine = snakeSpine(s);
  if (!spine.length) return 'empty';
  const step = count > 1 ? (spine.length - 1) / (count - 1) : 0;
  for (let i = 0; i < count; i++) {
    const p = spine[Math.min(spine.length - 1, Math.round(i * step))];
    const v = per + (i < remainder ? 1 : 0);
    state.food.push({
      id: nextId(state),
      x: round1(p[0]),
      y: round1(p[1]),
      r: snakeRadiusForValue(v),
      v,
      k: SNAKE_KIND_CORPSE,
    });
  }
  return 'ok';
}

/**
 * 推进一 tick（原地修改 state）。
 * dt 由运行时按真实经过时间给出，速度快慢与帧/tick 抖动解耦。
 */
/**
 * 推进一 tick（原地修改 state）。判定顺序严格按规格 §4，不可调换：
 * ① 先算所有存活蛇的 move → ② 撞墙/撞身体 → ③ 头对头 → ④ 应用 move（死者掉残骸、生者截断、
 * 加速者扣长度）→ ⑤ 磁铁吸附 → ⑥ 吃判定 + 补位 → ⑦ tick++ → ⑧ 模式结算。
 */
export function stepSnake(
  state: SnakeState,
  opts: { dt?: number; now?: number; random?: () => number } = {},
): SnakeStepResult {
  if (state.status !== 'playing') {
    return { died: [], ate: [], respawned: [], over: true };
  }
  const now = opts.now ?? Date.now();
  const random = opts.random ?? Math.random;
  const dt = clamp(opts.dt ?? SNAKE_TICK_MS / 1000, 0.004, 0.25);
  const variant: SnakeVariant = state.variant || 'endless';
  // 本局冻结的参数（建局时从数据库配置解析）；老对局没有则用代码默认值
  const p = state.params || DEFAULT_SNAKE_PARAMS;
  const died: string[] = [];
  const ate: string[] = [];
  let over = false;

  // ① 先算所有人的新位置（同一 tick 同时移动，先算后应用，避免"先动的占便宜"）
  const moves: Move[] = [];
  for (const s of state.snakes) {
    if (!s.alive) continue;
    // 按住加速 + 身长够才生效；加速时转弯半径更大（更危险）
    const boosting = s.boostHeld === true && (s.length || 0) > p.boostMinLen;
    // 速度随身长递减（贪吃蛇大作战手感）：长蛇更慢，角速度也随之下降
    const speed = snakeMoveSpeed(s.length || 0, boosting, p);
    const rate = snakeTurnRate(s.length || 0, boosting, p);
    const angle = turnToward(s.angle, s.targetAngle, rate * dt);
    moves.push({
      s,
      angle,
      ox: s.x,
      oy: s.y,
      nx: s.x + Math.cos(angle) * speed * dt,
      ny: s.y + Math.sin(angle) * speed * dt,
      boosting,
    });
  }

  // ② 碰撞判定：撞墙 / 压上别人的蛇身 —— 都是"谁撞谁死"，被撞的一方不受牵连
  const dead = new Set<string>();
  for (const m of moves) {
    if (
      m.nx < SNAKE_RADIUS || m.ny < SNAKE_RADIUS
      || m.nx > state.w - SNAKE_RADIUS || m.ny > state.h - SNAKE_RADIUS
    ) {
      dead.add(m.s.id);
      continue;
    }
    if (hitsBody(state, m, now)) dead.add(m.s.id);
  }

  // ③ 头对头：只有"双方互相接近"才算真对撞 —— 同向并行、擦肩而过都不触发。
  //    裁决：双盾都不死；单盾无盾方死；否则身长更长者活，等长双亡。
  //    已经因为撞墙/撞身体阵亡的一方不再连带对方（他撞了别人，自己担着）。
  for (let i = 0; i < moves.length; i++) {
    for (let j = i + 1; j < moves.length; j++) {
      const a = moves[i];
      const b = moves[j];
      if (dist(a.nx, a.ny, b.nx, b.ny) >= SNAKE_HEAD_RADIUS * 2) continue;
      if (a.s.team && a.s.team === b.s.team) continue;
      if (!approaching(a, b)) continue;
      if (dead.has(a.s.id) || dead.has(b.s.id)) continue;
      const aShielded = (a.s.invincibleUntil || 0) > now;
      const bShielded = (b.s.invincibleUntil || 0) > now;
      if (aShielded && bShielded) continue;
      if (aShielded) { dead.add(b.s.id); continue; }
      if (bShielded) { dead.add(a.s.id); continue; }
      const la = a.s.length || 0;
      const lb = b.s.length || 0;
      if (Math.abs(la - lb) < 0.5) {
        dead.add(a.s.id);
        dead.add(b.s.id);
      } else if (la > lb) {
        dead.add(b.s.id);
      } else {
        dead.add(a.s.id);
      }
    }
  }

  // ④ 应用移动（死者掉残骸；生者写路径；加速者从尾部扣长度并截断）
  for (const m of moves) {
    const s = m.s;
    if (dead.has(s.id)) {
      s.alive = false;
      // 死亡后停在"等待玩家决定"（重生 / 退出）状态，不再自动重生
      s.respawnAt = 0;
      s.boostHeld = false;
      died.push(s.id);
      dropCorpses(state, s);
      continue;
    }
    s.x = m.nx;
    s.y = m.ny;
    s.angle = m.angle;
    pushPath(s, m.ox, m.oy);
    if (m.boosting) {
      // 加速的代价：身长按秒扣，扣到下限为止（不扣分、不影响分数）
      s.length = Math.max(p.boostMinLen, s.length - p.boostDrain * dt);
      // **不清掉 boostHeld**：玩家的「按住」意图由玩家自己解除（松手）。
      // 扣到下限时加速自然不再生效（m.boosting 判定含身长条件），
      // 但按住状态保留 —— 吃到食物长回来后立刻自动恢复加速，不用重新按。
      // 之前在这里回写 false，会让「手指还按着」却收到「已松开」的快照，
      // 按钮当场变灰，玩家以为按键失灵。
    }
    truncatePath(s);
  }

  // ⑤ 磁铁吸附（必须在吃判定之前，否则拉过来的要等下一 tick 才入口）
  applyMagnet(state, now, dt);

  // ⑥ 吃判定：食物 / 残骸 / 道具
  for (const m of moves) {
    const s = m.s;
    if (dead.has(s.id)) continue;
    for (let i = state.food.length - 1; i >= 0; i--) {
      const f = state.food[i];
      if (dist(f.x, f.y, s.x, s.y) > SNAKE_HEAD_RADIUS + f.r) continue;
      state.food.splice(i, 1);
      const def = SNAKE_ITEM_BY_KIND[f.k];
      if (def) {
        // 道具：刷新式生效（不叠加），效果按注册表 key 分派
        if (def.key === 'magnet') s.magnetUntil = now + def.durationMs;
        else if (def.key === 'star') s.invincibleUntil = Math.max(s.invincibleUntil || 0, now + def.durationMs);
      } else {
        // 普通食物 / 尸体残骸：加分并按分值增长身体
        s.score += f.v;
        s.best = Math.max(s.best || 0, s.score);
        s.length = Math.min(p.maxLength, s.length + f.v * SNAKE_GROW_PER_SCORE);
      }
      if (!ate.includes(s.id)) ate.push(s.id);
    }
  }

  // ⑥ 补位：每 tick 最多各补 1 个（被吃即时补、不复制能量）
  if (countKind(state, SNAKE_KIND_FOOD) < SNAKE_FOOD_COUNT) spawnFood(state, random);
  if (countKinds(state, k => !!SNAKE_ITEM_BY_KIND[k]) < SNAKE_ITEM_COUNT) spawnItem(state, random);

  state.tick++;

  // ⑦ 模式结算
  if (variant === 'endless') {
    // 无尽模式对局永不结束：死掉的蛇保持 dead，等玩家选择重生 / 退出
    return { died, ate, respawned: [], over: false };
  }

  const teams = new Set(state.snakes.map(s => s.team).filter(Boolean));
  if (teams.size > 0) {
    state.teamScores = teamScores(state);
    const aliveTeams = new Set(state.snakes.filter(s => s.alive).map(s => s.team).filter(Boolean));
    // 提前结束：只剩一队存活 → 该队胜
    if (aliveTeams.size === 1) {
      state.status = 'over';
      const champion = [...aliveTeams][0] as string;
      state.winner = championPlayerOf(state, champion);
      return { died, ate, respawned: [], over: true };
    }
    // 全灭 或 时间到：按团队总分判胜（同分比各队最高单蛇，再同分平局）
    const timeUp = state.endsAt > 0 && now >= state.endsAt;
    if (aliveTeams.size === 0 || timeUp) {
      state.status = 'over';
      const champion = bestTeam(state);
      state.winner = champion ? championPlayerOf(state, champion) : '';
      return { died, ate, respawned: [], over: true };
    }
    return { died, ate, respawned: [], over: false };
  }

  // 无队伍兼容：只剩一条蛇 → 它赢；全灭 → 分数最高者，同分平局
  const remain = state.snakes.filter(s => s.alive);
  if (remain.length === 1) {
    state.status = 'over';
    state.winner = remain[0].id;
    over = true;
  } else if (remain.length === 0) {
    state.status = 'over';
    if (state.snakes.length === 1) {
      state.winner = '';
    } else {
      const ranked = state.snakes
        .map(s => ({ id: s.id, score: Math.max(s.score || 0, s.best || 0) }))
        .sort((a, b) => b.score - a.score);
      const tie = ranked.length > 1 && ranked[0].score === ranked[1].score;
      state.winner = tie ? '' : (ranked[0]?.id || '');
    }
    over = true;
  }

  return { died, ate, respawned: [], over };
}

/** 统计某类可拾取物数量 */
function countKind(state: SnakeState, kind: number): number {
  let n = 0;
  for (const f of state.food) if (f.k === kind) n++;
  return n;
}

/** 按条件统计可拾取物数量（道具用） */
function countKinds(state: SnakeState, pred: (kind: number) => boolean): number {
  let n = 0;
  for (const f of state.food) if (pred(f.k)) n++;
  return n;
}

/** 团队总分最高的队；同分比各队最高单蛇，再同分返回 ''（平局） */
function bestTeam(state: SnakeState): string {
  const scores = state.teamScores || teamScores(state);
  const best = new Map<string, number>();
  for (const s of state.snakes) {
    if (!s.team) continue;
    best.set(s.team, Math.max(best.get(s.team) || 0, Math.max(s.score || 0, s.best || 0)));
  }
  let win = '';
  let winScore = -1;
  let winBest = -1;
  for (const [team, score] of Object.entries(scores)) {
    const peak = best.get(team) || 0;
    if (score > winScore || (score === winScore && peak > winBest)) {
      win = team;
      winScore = score;
      winBest = peak;
    }
  }
  // 总分与最高单蛇都比不出来 → 平局
  const rivals = Object.entries(scores).filter(([t, v]) => t !== win && v === winScore && (best.get(t) || 0) === winBest);
  return rivals.length ? '' : win;
}


/** 队伍总积分：队内所有成员的最高分之和 */
export function teamScores(state: SnakeState): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const s of state.snakes) {
    if (!s.team) continue;
    const v = Math.max(s.score || 0, s.best || 0);
    scores[s.team] = (scores[s.team] || 0) + v;
  }
  return scores;
}

/** 队伍获胜时，该队贡献最高分的成员（作为 winner 上报） */
function championPlayerOf(state: SnakeState, team: string): string {
  const members = state.snakes.filter(s => s.team === team);
  if (!members.length) return '';
  const ranked = members
    .map(s => ({ id: s.id, score: Math.max(s.score || 0, s.best || 0) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.id || '';
}

/**
 * 网络用身体采样：从蛇头沿路径按固定弧长取点。
 * 固定间距保证"第 i 个点 ≈ 距头 i*spacing 的位置"，客户端可以按下标插值而不抖动。
 *
 * @param maxLength 本局的身长上限（决定采样点数量上限）；缺省用代码默认值。
 */
export function snakeSpine(s: SnakePlayerState, spacing = SNAKE_SEG_SPACING, maxLength = SNAKE_MAX_LENGTH): [number, number][] {
  const path = s.path;
  if (!path.length) return [[Math.round(s.x), Math.round(s.y)]];
  const out: [number, number][] = [[Math.round(path[0][0]), Math.round(path[0][1])]];
  const maxPts = Math.ceil(maxLength / spacing) + 2;
  let next = spacing;
  let acc = 0;
  for (let i = 1; i < path.length && out.length < maxPts; i++) {
    const ax = path[i - 1][0];
    const ay = path[i - 1][1];
    const bx = path[i][0];
    const by = path[i][1];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg < 1e-6) continue;
    while (acc + seg >= next && out.length < maxPts) {
      const t = (next - acc) / seg;
      out.push([Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t)]);
      next += spacing;
    }
    acc += seg;
  }
  return out;
}

/** 分数表：player_id -> 本局得分（取历史最高，跨重生不丢分） */
export function snakeScores(state: SnakeState): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const s of state.snakes) scores[s.id] = Math.max(s.score || 0, s.best || 0);
  return scores;
}
