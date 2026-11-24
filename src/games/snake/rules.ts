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
 *
 * 两种玩法共用同一套规则：
 * - 无尽挑战（variant=endless，房间制，1–10 人共享同一片地图）：
 *   死亡不会结束对局，停在"已出局"等玩家选择（重生 / 退出）；点重生后在空白处随机复活并带 3s 无敌。
 *   分数按"单条命最高分"记榜，死亡的瞬间就会结算进排行榜。
 * - 团队模式（variant=team，房间制，最多 6 队 × 每队 5 人）：
 *   队友之间不会互相碰撞致死（同队豁免），可以互相掩护；
 *   一支队伍全员出局即被淘汰，只剩一支队伍时该队获胜。
 *
 * 场上可拾取物（state.food）统一成一个数组，用 kind 区分四类：
 *   普通食物（分三档：小的多、大的少）/ 尸体残骸 / 磁铁 / 闪电。
 */

export type SnakeVariant = 'endless' | 'team';

/** 世界尺寸（像素）：远大于视口，镜头跟随主角 */
export const SNAKE_WORLD_W = 3600;
export const SNAKE_WORLD_H = 2600;
/** 场上同时存在的普通食物数量 */
export const SNAKE_FOOD_COUNT = 70;
/** 场上同时存在的道具数量（磁铁 / 闪电） */
export const SNAKE_ITEM_COUNT = 6;
/**
 * 食物分档：小食物数量多、大食物数量少。
 * - radius 决定视觉大小与碰撞判定；
 * - value 决定收益（同时按比例决定身体增长，见 SNAKE_GROW_PER_SCORE）；
 * - weight 是抽取权重（相对值，不必凑满 100）：小档 62%、中档 26%、大档 12%。
 * 加权平均单颗价值 ≈ 9.8 分，与旧版"每颗 10 分"基本持平，分档只是让收益更有起伏。
 */
export const SNAKE_FOOD_TIERS = [
  { radius: 5, value: 5, weight: 62 },
  { radius: 8, value: 12, weight: 26 },
  { radius: 11, value: 30, weight: 12 },
] as const;
/** 最小档（小食物）的分值 */
export const SNAKE_FOOD_SCORE = SNAKE_FOOD_TIERS[0].value;
/** 每 1 分值增长的身体像素（旧版 10 分 → 18px，保持同一条比例线） */
export const SNAKE_GROW_PER_SCORE = 1.8;
/** 道具半径（像素） */
export const SNAKE_ITEM_RADIUS = 9;

/**
 * 场上可拾取物的类型（用数字而非字符串：快照每帧广播，体积越小越好）。
 * 客户端与 AI 侧各自镜像一份同名常量。
 */
export const SNAKE_KIND_FOOD = 0;      // 普通食物
export const SNAKE_KIND_CORPSE = 1;    // 尸体残骸
export const SNAKE_KIND_MAGNET = 2;    // 磁铁
export const SNAKE_KIND_LIGHTNING = 3; // 闪电

/** 一个可拾取物（食物 / 残骸 / 道具） */
export interface SnakeFoodItem {
  x: number;
  y: number;
  /** 半径（像素）：决定碰撞判定与绘制大小 */
  r: number;
  /** 分值：吃到后增加的分数；道具为 0 */
  v: number;
  /** 类型：SNAKE_KIND_* */
  k: number;
}

/**
 * 道具：吃到不加长度、不加分，只有特殊效果（因此不会污染能量收支）。
 * - magnet：持续期间把蛇头一定半径内的食物拉过来（自动收菜）；
 * - lightning：持续期间小幅度加速（比主动加速 1.85 温和得多）。
 * 效果是"刷新式"：再吃一个就把剩余时间重置为完整时长，不叠加倍率。
 */
export const SNAKE_MAGNET_MS = 6000;
export const SNAKE_MAGNET_RADIUS = 180;
export const SNAKE_MAGNET_PULL = 260;
export const SNAKE_LIGHTNING_MS = 4000;
export const SNAKE_LIGHTNING_MULT = 1.35;

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
export const SNAKE_CORPSE_PER_LENGTH = 22;
export const SNAKE_CORPSE_MIN = 3;
export const SNAKE_CORPSE_MAX = 44;
/** 单颗残骸的价值上限（与最大档食物同值） */
export const SNAKE_CORPSE_VALUE_MAX = 30;
/** 场上残骸的总价值上限（世界总能量的硬顶） */
export const SNAKE_CORPSE_FIELD_CAP = 1800;
/** 场上残骸的数量上限（同时也是快照体积的保护） */
export const SNAKE_CORPSE_FIELD_MAX = 60;

/** 推进间隔（毫秒）：20Hz，客户端负责插值成 60fps */
export const SNAKE_TICK_MS = 50;

/** 蛇身半径 / 蛇头半径（像素） */
export const SNAKE_RADIUS = 12;
export const SNAKE_HEAD_RADIUS = 13;
/** 基础速度 / 加速倍率（像素每秒） */
export const SNAKE_SPEED = 170;
export const SNAKE_BOOST_MULT = 1.85;
/**
 * 最小转弯半径（像素）：手感用"能拐多小的弯"描述，角速度由 ω = v / R 推导。
 * 这样速度越快角速度越大，但轨迹半径永远不小于 R —— 允许贴着很小的圈盘旋，
 * 又不会出现"原地自转"这种物理上说不通的操作。
 * 26px ≈ 两倍蛇身直径，视觉上就是一个小圆环。
 */
export const SNAKE_MIN_TURN_RADIUS = 26;
export const SNAKE_BOOST_MIN_TURN_RADIUS = 42;
/** 最大转向角速度（弧度每秒，由上面的半径推导）≈ 6.54 / 7.49 */
export const SNAKE_TURN_RATE = SNAKE_SPEED / SNAKE_MIN_TURN_RADIUS;
export const SNAKE_BOOST_TURN_RATE = (SNAKE_SPEED * SNAKE_BOOST_MULT) / SNAKE_BOOST_MIN_TURN_RADIUS;

/** 初始身长 / 上限（像素） */
export const SNAKE_BODY_LENGTH = 110;
export const SNAKE_MAX_LENGTH = 900;

/** 加速：持续时长 / 冷却（毫秒）—— 3s 冲刺，1 分钟一次 */
export const SNAKE_BOOST_MS = 3000;
export const SNAKE_BOOST_CD_MS = 60_000;
/** 无尽模式：重生无敌时间（毫秒）。死亡后由玩家点「重生」才复活，不再自动重生 */
export const SNAKE_INVINCIBLE_MS = 3000;

/** 内部路径采样步长（像素）：越小身体曲线越顺，越大内存/CPU 越省 */
export const SNAKE_PATH_STEP = 3;
/** 发给客户端的身体采样间距（像素）：按弧长等距，index 与身长一一对应，便于插值 */
export const SNAKE_SEG_SPACING = 18;
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
  /** 无敌截止时间戳（ms）；无敌期间不结算别人蛇身的碰撞（撞自己本来就不死，撞墙照常死） */
  invincibleUntil: number;
  /** 加速截止时间戳（ms） */
  boostUntil: number;
  /** 加速冷却结束时间戳（ms） */
  boostReadyAt: number;
  /** 磁铁效果截止时间戳（ms）：期间自动吸附附近食物 */
  magnetUntil: number;
  /** 闪电效果截止时间戳（ms）：期间小幅加速 */
  lightningUntil: number;
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
  /** 场上可拾取物（普通食物 / 尸体残骸 / 磁铁 / 闪电） */
  food: SnakeFoodItem[];
  snakes: SnakePlayerState[];
  status: 'playing' | 'over';
  /** 胜者 player_id；'' 表示平局 */
  winner: string;
  /** 玩法；缺省按多人对战处理（兼容旧对局数据） */
  variant: SnakeVariant;
  /** 团队模式下各队总积分：team -> 累计分数 */
  teamScores?: Record<string, number>;
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

/** 随机撒一颗普通食物（分档）；连续失败就放弃（场上食物略少也不影响可玩性） */
export function spawnFood(state: SnakeState, random: () => number = Math.random): SnakeFoodItem | null {
  const margin = 40;
  const tier = pickTier(random);
  for (let i = 0; i < 60; i++) {
    const x = margin + random() * (state.w - margin * 2);
    const y = margin + random() * (state.h - margin * 2);
    if (nearSnake(state, x, y, 70)) continue;
    if (state.food.some(f => dist(f.x, f.y, x, y) < 55)) continue;
    const item: SnakeFoodItem = {
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

/** 随机撒一个道具（磁铁 / 闪电各一半）；道具不加长度也不加分 */
export function spawnItem(state: SnakeState, random: () => number = Math.random): SnakeFoodItem | null {
  const margin = 60;
  for (let i = 0; i < 60; i++) {
    const x = margin + random() * (state.w - margin * 2);
    const y = margin + random() * (state.h - margin * 2);
    if (nearSnake(state, x, y, 90)) continue;
    if (state.food.some(f => dist(f.x, f.y, x, y) < 70)) continue;
    const item: SnakeFoodItem = {
      x: round1(x),
      y: round1(y),
      r: SNAKE_ITEM_RADIUS,
      v: 0,
      k: random() < 0.5 ? SNAKE_KIND_MAGNET : SNAKE_KIND_LIGHTNING,
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

function newSnake(id: string, x: number, y: number, angle: number, team = ''): SnakePlayerState {
  return {
    id,
    x,
    y,
    angle: normalizeAngle(angle),
    targetAngle: normalizeAngle(angle),
    path: straightPath(x, y, angle, SNAKE_BODY_LENGTH),
    length: SNAKE_BODY_LENGTH,
    alive: true,
    score: 0,
    best: 0,
    invincibleUntil: 0,
    boostUntil: 0,
    boostReadyAt: 0,
    magnetUntil: 0,
    lightningUntil: 0,
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
    variant = 'team',
    teams = {},
  } = opts;

  const state: SnakeState = {
    w: width,
    h: height,
    tick: 0,
    food: [],
    snakes: [],
    status: 'playing',
    winner: '',
    variant,
  };

  for (const id of playerIds) addSnake(state, id, random, teams[id] || '');
  for (let i = 0; i < foodCount; i++) spawnFood(state, random);
  for (let i = 0; i < itemCount; i++) spawnItem(state, random);
  return state;
}

/** 在现有局面里加一条蛇（开局 / 中途加入 / 重连补位都走它，保证避开场上已有的蛇） */
export function addSnake(state: SnakeState, id: string, random: () => number = Math.random, team = ''): SnakePlayerState {
  const spot = randomSpawn(state, random);
  const snake = newSnake(id, spot.x, spot.y, spot.angle, team);
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

/** 加速：冷却结束才可用，持续 SNAKE_BOOST_MS；返回是否生效 */
export function boostSnake(state: SnakeState, playerId: string, now: number = Date.now()): boolean {
  if (state.status !== 'playing') return false;
  const snake = state.snakes.find(s => s.id === playerId);
  if (!snake || !snake.alive) return false;
  if ((snake.boostUntil || 0) > now) return false;
  if ((snake.boostReadyAt || 0) > now) return false;
  snake.boostUntil = now + SNAKE_BOOST_MS;
  snake.boostReadyAt = now + SNAKE_BOOST_CD_MS;
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
  snake.x = spot.x;
  snake.y = spot.y;
  snake.angle = normalizeAngle(spot.angle);
  snake.targetAngle = snake.angle;
  snake.path = straightPath(spot.x, spot.y, spot.angle, SNAKE_BODY_LENGTH);
  snake.length = SNAKE_BODY_LENGTH;
  snake.alive = true;
  snake.score = 0;
  snake.respawnAt = 0;
  snake.respawns = (snake.respawns || 0) + 1;
  snake.invincibleUntil = now + SNAKE_INVINCIBLE_MS;
  snake.boostUntil = 0;
  snake.boostReadyAt = now;
  snake.magnetUntil = 0;
  snake.lightningUntil = 0;
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
}

/**
 * 撞身体：蛇头这一 tick 扫过的线段到对方身体中心线的距离。自己的蛇身不参与判定。
 * 团队模式下同队成员之间不互相碰撞（队友可以互相掩护）。
 */
function hitsBody(state: SnakeState, m: Move, now: number): boolean {
  // 无敌只免疫别人的身体；撞自己本来就没事，撞墙照常死
  if ((m.s.invincibleUntil || 0) > now) return false;
  for (const other of state.snakes) {
    if (!other.alive || other === m.s) continue;
    // 同队豁免：队友撞到队友不算死
    if (m.s.team && other.team === m.s.team) continue;
    const path = other.path;
    for (let i = 0; i < path.length; i += 2) {
      if (pointSegDist2(path[i][0], path[i][1], m.ox, m.oy, m.nx, m.ny) < SNAKE_HIT_R2) return true;
    }
  }
  return false;
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
      if (f.k === SNAKE_KIND_MAGNET || f.k === SNAKE_KIND_LIGHTNING) continue;
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
  const score = Math.max(0, Math.floor(s.score || 0));
  // 目标总价值：死亡分数的 ρ 倍（向下取整，保证"残骸总价值 ≤ score × ρ"严格成立）
  const targetTotal = Math.floor(score * SNAKE_CORPSE_RATIO);
  if (targetTotal <= 0) return;

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
  if (count <= 0) return;

  // 单颗价值：均摊，单颗封顶；场上总价值还有硬顶
  let per = Math.min(Math.floor(targetTotal / count), SNAKE_CORPSE_VALUE_MAX);
  per = Math.min(per, Math.floor((SNAKE_CORPSE_FIELD_CAP - valueOnField) / count));
  if (per < 1) return;

  // 余数补给前几颗：让残骸总价值尽量贴近 score × ρ（且绝不超过）
  const remainder = Math.min(targetTotal - per * count, count - per);

  // 沿身体摆放：蛇头在 path[0]，尾巴在末尾
  const spine = snakeSpine(s);
  if (!spine.length) return;
  const step = count > 1 ? (spine.length - 1) / (count - 1) : 0;
  for (let i = 0; i < count; i++) {
    const p = spine[Math.min(spine.length - 1, Math.round(i * step))];
    const v = per + (i < remainder ? 1 : 0);
    state.food.push({
      x: round1(p[0]),
      y: round1(p[1]),
      r: snakeRadiusForValue(v),
      v,
      k: SNAKE_KIND_CORPSE,
    });
  }
}

/**
 * 推进一 tick（原地修改 state）。
 * dt 由运行时按真实经过时间给出，速度快慢与帧/tick 抖动解耦。
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
  const variant: SnakeVariant = state.variant || 'team';
  const died: string[] = [];
  const ate: string[] = [];
  // 对局是否结束（团队分支与兼容分支共用，必须在分支之前声明，否则会踩 TDZ）
  let over = false;

  // 1. 先算所有人的新位置（同一 tick 同时移动，先算后应用，避免"先动的占便宜"）
  const moves: Move[] = [];
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const boosting = (s.boostUntil || 0) > now;
    const lightning = (s.lightningUntil || 0) > now;
    // 主动加速优先于闪电道具（1.85 > 1.35，两者不叠加）
    const mult = boosting ? SNAKE_BOOST_MULT : (lightning ? SNAKE_LIGHTNING_MULT : 1);
    const speed = SNAKE_SPEED * mult;
    // 角速度由"最小转弯半径"反推：v / R，所以加速时转得更快但弯更大
    const rate = speed / (boosting ? SNAKE_BOOST_MIN_TURN_RADIUS : SNAKE_MIN_TURN_RADIUS);
    const angle = turnToward(s.angle, s.targetAngle, rate * dt);
    moves.push({
      s,
      angle,
      ox: s.x,
      oy: s.y,
      nx: s.x + Math.cos(angle) * speed * dt,
      ny: s.y + Math.sin(angle) * speed * dt,
    });
  }

  // 2. 碰撞判定
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
  // 头对头：两败俱伤（无敌的一方免疫）；同队之间不触发
  for (let i = 0; i < moves.length; i++) {
    for (let j = i + 1; j < moves.length; j++) {
      const a = moves[i];
      const b = moves[j];
      if (dist(a.nx, a.ny, b.nx, b.ny) >= SNAKE_HEAD_RADIUS * 2) continue;
      if (a.s.team && a.s.team === b.s.team) continue;
      if ((a.s.invincibleUntil || 0) <= now) dead.add(a.s.id);
      if ((b.s.invincibleUntil || 0) <= now) dead.add(b.s.id);
    }
  }

  // 3. 应用移动（含死亡处理：死亡时留下尸体残骸）
  for (const m of moves) {
    const s = m.s;
    if (dead.has(s.id)) {
      s.alive = false;
      // 无尽模式：死亡后停在"等待玩家决定"（重生 / 退出）状态，不再自动重生；
      // respawnAt 归零即代表"等玩家点重生"，客户端据此弹框。
      s.respawnAt = 0;
      died.push(s.id);
      dropCorpses(state, s);
      continue;
    }
    s.x = m.nx;
    s.y = m.ny;
    s.angle = m.angle;
    pushPath(s, m.ox, m.oy);
    truncatePath(s);
  }

  // 4. 磁铁吸附（先吸附再判定吃，否则拉过来的食物要等下一 tick 才入口）
  applyMagnet(state, now, dt);

  // 5. 吃食物 / 残骸 / 道具
  for (const m of moves) {
    const s = m.s;
    if (dead.has(s.id)) continue;
    for (let i = state.food.length - 1; i >= 0; i--) {
      const f = state.food[i];
      if (dist(f.x, f.y, s.x, s.y) > SNAKE_HEAD_RADIUS + f.r) continue;
      state.food.splice(i, 1);
      if (f.k === SNAKE_KIND_MAGNET) {
        // 磁铁：刷新式生效（不叠加倍率）
        s.magnetUntil = now + SNAKE_MAGNET_MS;
      } else if (f.k === SNAKE_KIND_LIGHTNING) {
        s.lightningUntil = now + SNAKE_LIGHTNING_MS;
      } else {
        // 普通食物 / 尸体残骸：加分并按分值增长身体
        s.score += f.v;
        s.best = Math.max(s.best || 0, s.score);
        s.length = Math.min(SNAKE_MAX_LENGTH, s.length + f.v * SNAKE_GROW_PER_SCORE);
      }
      if (!ate.includes(s.id)) ate.push(s.id);
      // 补位：普通食物与道具吃完要补新的，尸体残骸吃完就没了（不复制能量）
      if (f.k === SNAKE_KIND_FOOD) spawnFood(state, random);
      else if (f.k === SNAKE_KIND_MAGNET || f.k === SNAKE_KIND_LIGHTNING) spawnItem(state, random);
    }
  }

  state.tick++;

  // 6. 无尽模式：对局永不结束。死掉的蛇保持 dead 状态等玩家选择
  //    （重生走 respawnSnake 指令，退出走房间 leave），这里不做自动重生。
  if (variant === 'endless') {
    return { died, ate, respawned: [], over: false };
  }

  // 7. 团队模式：一支队伍全员出局即淘汰；只剩一支队伍时该队获胜。
  //    队伍总积分用于同分时的决胜与"全灭"场景。
  const remain = state.snakes.filter(s => s.alive);
  const teams = new Set(state.snakes.map(s => s.team).filter(Boolean));
  if (teams.size > 0) {
    state.teamScores = teamScores(state);
    const aliveTeams = new Set(remain.map(s => s.team).filter(Boolean));
    // 同一队的最后一条蛇倒了，这队就出局
    if (aliveTeams.size <= 1) {
      state.status = 'over';
      const champion = [...aliveTeams][0] || '';
      state.winner = champion ? championPlayerOf(state, champion) : '';
      over = true;
      return { died, ate, respawned: [], over };
    }
    return { died, ate, respawned: [], over };
  }

  // 8. 无队伍模式（兼容旧对局）：只剩一条蛇 → 它赢；全灭 → 分数最高者，同分平局
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
 */
export function snakeSpine(s: SnakePlayerState, spacing = SNAKE_SEG_SPACING): [number, number][] {
  const path = s.path;
  if (!path.length) return [[Math.round(s.x), Math.round(s.y)]];
  const out: [number, number][] = [[Math.round(path[0][0]), Math.round(path[0][1])]];
  const maxPts = Math.ceil(SNAKE_MAX_LENGTH / spacing) + 2;
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
