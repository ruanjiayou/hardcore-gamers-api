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
 * - 无尽挑战（variant=endless，房间制，1–6 人共享同一片地图）：
 *   死亡不会结束对局，停在"已出局"等玩家选择（重生 / 退出）；点重生后在空白处随机复活并带 3s 无敌。
 *   分数按"单条命最高分"记榜，死亡的瞬间就会结算进排行榜。
 * - 多人对战（variant=multi，2–4 人）：撞墙 / 撞蛇即淘汰，活到最后（或全灭按分）结束。
 */

export type SnakeVariant = 'endless' | 'multi';

/** 世界尺寸（像素）：远大于视口，镜头跟随主角 */
export const SNAKE_WORLD_W = 3600;
export const SNAKE_WORLD_H = 2600;
/** 场上同时存在的食物数量 */
export const SNAKE_FOOD_COUNT = 70;
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

/** 初始身长 / 每颗食物增长 / 上限（像素） */
export const SNAKE_BODY_LENGTH = 110;
export const SNAKE_GROW_PER_FOOD = 18;
export const SNAKE_MAX_LENGTH = 900;
/** 每颗食物的分数 */
export const SNAKE_FOOD_SCORE = 10;
export const SNAKE_FOOD_RADIUS = 7;

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
  /** 无尽模式：可重生时间戳（ms） */
  respawnAt: number;
  /** 重生次数（HUD 展示用） */
  respawns: number;
}

export interface SnakeState {
  /** 世界宽高（像素） */
  w: number;
  h: number;
  tick: number;
  /** 食物坐标（像素，浮点） */
  food: [number, number][];
  snakes: SnakePlayerState[];
  status: 'playing' | 'over';
  /** 胜者 player_id；'' 表示平局 */
  winner: string;
  /** 玩法；缺省按多人对战处理（兼容旧对局数据） */
  variant: SnakeVariant;
}

export interface SnakeStepResult {
  /** 本 tick 淘汰的蛇 */
  died: string[];
  /** 本 tick 吃到食物的蛇 */
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

export const isSnakeVariant = (v: unknown): v is SnakeVariant => v === 'endless' || v === 'multi';
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

/** 随机撒一颗食物；连续失败就放弃（场上食物略少也不影响可玩性） */
export function spawnFood(state: SnakeState, random: () => number = Math.random): [number, number] | null {
  const margin = 40;
  for (let i = 0; i < 60; i++) {
    const x = margin + random() * (state.w - margin * 2);
    const y = margin + random() * (state.h - margin * 2);
    if (nearSnake(state, x, y, 70)) continue;
    if (state.food.some(([fx, fy]) => dist(fx, fy, x, y) < 55)) continue;
    const pos: [number, number] = [round1(x), round1(y)];
    state.food.push(pos);
    return pos;
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

function newSnake(id: string, x: number, y: number, angle: number): SnakePlayerState {
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
    respawnAt: 0,
    respawns: 0,
  };
}

export interface CreateSnakeOptions {
  width?: number;
  height?: number;
  foodCount?: number;
  random?: () => number;
  variant?: SnakeVariant;
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
    random = Math.random,
    variant = 'multi',
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

  for (const id of playerIds) addSnake(state, id, random);
  for (let i = 0; i < foodCount; i++) spawnFood(state, random);
  return state;
}

/** 在现有局面里加一条蛇（开局 / 中途加入 / 重连补位都走它，保证避开场上已有的蛇） */
export function addSnake(state: SnakeState, id: string, random: () => number = Math.random): SnakePlayerState {
  const spot = randomSpawn(state, random);
  const snake = newSnake(id, spot.x, spot.y, spot.angle);
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

/** 撞身体：蛇头这一 tick 扫过的线段到对方身体中心线的距离。自己的蛇身不参与判定 */
function hitsBody(state: SnakeState, m: Move, now: number): boolean {
  // 无敌只免疫别人的身体；撞自己本来就没事，撞墙照常死
  if ((m.s.invincibleUntil || 0) > now) return false;
  for (const other of state.snakes) {
    if (!other.alive || other === m.s) continue;
    const path = other.path;
    for (let i = 0; i < path.length; i += 2) {
      if (pointSegDist2(path[i][0], path[i][1], m.ox, m.oy, m.nx, m.ny) < SNAKE_HIT_R2) return true;
    }
  }
  return false;
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
  const variant: SnakeVariant = state.variant || 'multi';
  const died: string[] = [];
  const ate: string[] = [];

  // 1. 先算所有人的新位置（同一 tick 同时移动，先算后应用，避免"先动的占便宜"）
  const moves: Move[] = [];
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const boosting = (s.boostUntil || 0) > now;
    const speed = SNAKE_SPEED * (boosting ? SNAKE_BOOST_MULT : 1);
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
  // 头对头：两败俱伤（无敌的一方免疫）
  for (let i = 0; i < moves.length; i++) {
    for (let j = i + 1; j < moves.length; j++) {
      const a = moves[i];
      const b = moves[j];
      if (dist(a.nx, a.ny, b.nx, b.ny) >= SNAKE_HEAD_RADIUS * 2) continue;
      if ((a.s.invincibleUntil || 0) <= now) dead.add(a.s.id);
      if ((b.s.invincibleUntil || 0) <= now) dead.add(b.s.id);
    }
  }

  // 3. 应用移动 / 死亡 / 吃食物
  for (const m of moves) {
    const s = m.s;
    if (dead.has(s.id)) {
      s.alive = false;
      // 无尽模式：死亡后停在"等待玩家决定"（重生 / 退出）状态，不再自动重生；
      // respawnAt 归零即代表"等玩家点重生"，客户端据此弹框。
      s.respawnAt = 0;
      died.push(s.id);
      continue;
    }
    s.x = m.nx;
    s.y = m.ny;
    s.angle = m.angle;
    pushPath(s, m.ox, m.oy);

    for (let i = state.food.length - 1; i >= 0; i--) {
      const [fx, fy] = state.food[i];
      if (dist(fx, fy, s.x, s.y) > SNAKE_HEAD_RADIUS + SNAKE_FOOD_RADIUS) continue;
      state.food.splice(i, 1);
      s.score += SNAKE_FOOD_SCORE;
      s.best = Math.max(s.best || 0, s.score);
      s.length = Math.min(SNAKE_MAX_LENGTH, s.length + SNAKE_GROW_PER_FOOD);
      if (!ate.includes(s.id)) ate.push(s.id);
      spawnFood(state, random);
    }
    truncatePath(s);
  }

  state.tick++;

  // 4. 无尽模式：对局永不结束。死掉的蛇保持 dead 状态等玩家选择
  //    （重生走 respawnSnake 指令，退出走房间 leave），这里不做自动重生。
  if (variant === 'endless') {
    return { died, ate, respawned: [], over: false };
  }

  // 5. 多人对战：只剩一条蛇 → 它赢；全灭 → 分数最高者，同分平局
  const remain = state.snakes.filter(s => s.alive);
  let over = false;
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
