/**
 * 贪吃蛇规则验收用例。
 *
 * 用例编号对应《贪吃蛇大作战 规则规格》§12（21 条），第 20/21 条分别在
 * 客户端（lobby/tests）与机器人（robot/test）侧验证，这里覆盖规则层可断言的 19 条
 * 加若干结构不变量（世界/食物数量/身体采样/分数表）。
 */
import { describe, test, expect } from 'bun:test';
import {
  SNAKE_BOOST_DRAIN,
  SNAKE_BOOST_MIN_LEN,
  SNAKE_BOOST_MULT,
  SNAKE_BODY_LENGTH,
  SNAKE_CORPSE_FIELD_CAP,
  SNAKE_CORPSE_FIELD_MAX,
  SNAKE_CORPSE_MAX,
  SNAKE_CORPSE_MIN,
  SNAKE_CORPSE_RATIO,
  SNAKE_CORPSE_VALUE_MAX,
  SNAKE_FOOD_COUNT,
  SNAKE_FOOD_TIERS,
  SNAKE_GROW_PER_SCORE,
  SNAKE_HEAD_RADIUS,
  SNAKE_INVINCIBLE_MS,
  SNAKE_ITEM_COUNT,
  SNAKE_ITEM_DEFS,
  SNAKE_KIND_CORPSE,
  SNAKE_KIND_FOOD,
  SNAKE_KIND_MAGNET,
  SNAKE_KIND_STAR,
  SNAKE_MAGNET_RADIUS,
  SNAKE_MAX_LENGTH,
  SNAKE_MIN_TURN_RADIUS,
  SNAKE_PATH_STEP,
  SNAKE_RADIUS,
  SNAKE_SEG_SPACING,
  SNAKE_SPEED,
  SNAKE_TEAM_MATCH_MS,
  SNAKE_WORLD_H,
  SNAKE_WORLD_W,
  createSnakeState,
  normalizeAngle,
  respawnSnake,
  setBoost,
  snakeScores,
  snakeSpine,
  spawnFood,
  spawnItem,
  stepSnake,
  type SnakeFoodItem,
  type SnakePlayerState,
  type SnakeState,
} from '../src/games/snake/rules';

const STEP = 0.05;
const now = 1_700_000_000_000;

/** 把折线按 SNAKE_PATH_STEP 加密（模拟蛇走过的轨迹） */
function densify(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [[points[0][0], points[0][1]]];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const seg = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(seg / SNAKE_PATH_STEP));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

const pathLength = (path: [number, number][]) => {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return total;
};

/** 用折线造一条蛇：points[0] 是蛇头，身体朝 points[1] 反方向铺开 */
function snakeFromPath(id: string, points: [number, number][], length?: number): SnakePlayerState {
  const path = densify(points);
  const [x, y] = path[0];
  const next = path[1] || path[0];
  const angle = normalizeAngle(Math.atan2(y - next[1], x - next[0]));
  return {
    id,
    x,
    y,
    angle,
    targetAngle: angle,
    path,
    length: length ?? pathLength(path),
    alive: true,
    score: 0,
    best: 0,
    invincibleUntil: 0,
    boostHeld: false,
    magnetUntil: 0,
    starUntil: 0,
    respawnAt: 0,
    respawns: 0,
    team: '',
  };
}

/** 一条朝右的直蛇（头在 x,y，身体向左铺 length 像素） */
const straight = (id: string, x: number, y: number, length = SNAKE_BODY_LENGTH) =>
  snakeFromPath(id, [[x, y], [x - length, y]], length);

function makeState(
  snakes: SnakePlayerState[],
  food: SnakeFoodItem[] = [],
  opts: { variant?: 'endless' | 'team'; w?: number; h?: number; endsAt?: number } = {},
): SnakeState {
  return {
    w: opts.w ?? SNAKE_WORLD_W,
    h: opts.h ?? SNAKE_WORLD_H,
    tick: 0,
    food: food.map(f => ({ ...f })),
    snakes,
    status: 'playing',
    winner: '',
    variant: opts.variant ?? 'team',
    endsAt: opts.endsAt ?? 0,
    nextItemId: 1000,
  };
}

let foodSeq = 1;
/** 造一颗普通食物 */
const foodAt = (x: number, y: number, value = SNAKE_FOOD_TIERS[0].value): SnakeFoodItem => ({
  id: foodSeq++,
  x,
  y,
  r: value >= 20 ? SNAKE_FOOD_TIERS[2].radius : (value >= 8 ? SNAKE_FOOD_TIERS[1].radius : SNAKE_FOOD_TIERS[0].radius),
  v: value,
  k: SNAKE_KIND_FOOD,
});

/** 造一个道具 */
const itemAt = (x: number, y: number, kind: number): SnakeFoodItem => ({
  id: foodSeq++,
  x,
  y,
  r: 11,
  v: 0,
  k: kind,
});

describe('贪吃蛇规则（规格 §12 验收用例）', () => {
  // ---------- 结构不变量 ----------
  test('常量与规格一致，世界/数量/采样都按总表', () => {
    expect(SNAKE_WORLD_W).toBe(4800);
    expect(SNAKE_WORLD_H).toBe(3400);
    expect(SNAKE_RADIUS).toBe(15);
    expect(SNAKE_HEAD_RADIUS).toBe(16);
    expect(SNAKE_BODY_LENGTH).toBe(160);
    expect(SNAKE_MAX_LENGTH).toBe(2400);
    expect(SNAKE_SEG_SPACING).toBe(22);
    expect(SNAKE_FOOD_COUNT).toBe(100);
    expect(SNAKE_ITEM_COUNT).toBe(8);
    expect(SNAKE_MIN_TURN_RADIUS).toBe(25);
    // 道具是注册表：种类、kind 与规格一致，加新道具只加一项
    expect(SNAKE_ITEM_DEFS.map(d => d.key)).toEqual(['magnet', 'star']);
    expect(SNAKE_ITEM_DEFS.map(d => d.kind)).toEqual([2, 3]);
  });

  test('建局：食物/道具按目标数量铺满，拾取物 id 唯一，蛇在界内', () => {
    const state = createSnakeState(['p1', 'p2'], { variant: 'team', teams: { p1: '红队', p2: '蓝队' } });
    expect(state.food.filter(f => f.k === SNAKE_KIND_FOOD).length).toBe(SNAKE_FOOD_COUNT);
    expect(state.food.filter(f => f.k >= 2).length).toBe(SNAKE_ITEM_COUNT);
    expect(new Set(state.food.map(f => f.id)).size).toBe(state.food.length);
    for (const s of state.snakes) {
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(SNAKE_WORLD_W);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(SNAKE_WORLD_H);
      expect(s.length).toBe(SNAKE_BODY_LENGTH);
    }
  });

  test('身体采样：从蛇头起等距 SEG_SPACING，且是 path[0]（头）', () => {
    const s = straight('p1', 1000, 1000, 240);
    const spine = snakeSpine(s);
    expect(spine[0]).toEqual([1000, 1000]);
    for (let i = 1; i < spine.length; i++) {
      const d = Math.hypot(spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1]);
      expect(d).toBeGreaterThan(SNAKE_SEG_SPACING - 2);
      expect(d).toBeLessThan(SNAKE_SEG_SPACING + 2);
    }
  });

  // ---------- 1 直行 ----------
  test('用例 1：单蛇直行 3s 前进 510px、不死', () => {
    const a = straight('p1', 500, 500);
    const state = makeState([a], [], { variant: 'endless' });
    for (let i = 0; i < 60; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.alive).toBe(true);
    expect(a.x - 500).toBeCloseTo(SNAKE_SPEED * 3, 1);
  });

  // ---------- 2 自撞 ----------
  test('用例 2：蛇头穿过自己身体不死（规则层直接判正）', () => {
    // 8 字形：头从自己身体正中穿过
    const a = snakeFromPath('p1', [[500, 500], [700, 500], [700, 700], [500, 700], [500, 520]]);
    a.angle = Math.PI / 2;
    a.targetAngle = Math.PI / 2;
    const state = makeState([a], [], { variant: 'endless' });
    stepSnake(state, { dt: STEP, now });
    expect(a.alive).toBe(true);
  });

  // ---------- 3 撞身体 ----------
  test('用例 3：A 撞 B 身体 → A 死、B 活、A 掉残骸、B 分数不变', () => {
    const a = straight('a', 320, 300);
    a.score = 300;
    const b = snakeFromPath('b', [[340, 200], [340, 400]]);
    const state = makeState([a, b], [], { variant: 'endless' });
    for (let i = 0; i < 3 && a.alive; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(true);
    expect(b.score).toBe(0);
    expect(state.food.some(f => f.k === SNAKE_KIND_CORPSE)).toBe(true);
  });

  // ---------- 4 并行 ----------
  test('用例 4：同向并行、头距 20~32px → 都不死（approaching=false）', () => {
    const a = straight('a', 600, 600);
    const b = straight('b', 608, 630);
    expect(Math.hypot(608 - 600, 630 - 600)).toBeLessThan(SNAKE_HEAD_RADIUS * 2);
    const state = makeState([a, b], [], { variant: 'endless' });
    for (let i = 0; i < 5; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
  });

  // ---------- 5/6 对撞 ----------
  test('用例 5：对撞 la=300 lb=200 → 短的 B 死、长的 A 活', () => {
    const a = straight('a', 1290, 1200, 300);
    // 头在 1330，身体朝右铺（朝左的蛇，身体在它身后）
    const b = snakeFromPath('b', [[1330, 1200], [1530, 1200]], 200);
    const state = makeState([a, b], [], { variant: 'endless' });
    for (let i = 0; i < 4 && a.alive && b.alive; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(false);
  });

  test('用例 6：等长对撞 → 双亡', () => {
    const a = straight('a', 1290, 1200, 200);
    // 头在 1330，身体朝右铺（朝左的蛇，身体在它身后）
    const b = snakeFromPath('b', [[1330, 1200], [1530, 1200]], 200);
    const state = makeState([a, b], [], { variant: 'endless' });
    for (let i = 0; i < 4 && (a.alive || b.alive); i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
  });

  // ---------- 7/8 无敌 ----------
  test('用例 7：无敌 A 撞 B 身体 → 都不死', () => {
    const a = straight('a', 320, 300);
    a.invincibleUntil = now + 5000;
    const b = snakeFromPath('b', [[340, 200], [340, 400]]);
    const state = makeState([a, b], [], { variant: 'endless' });
    for (let i = 0; i < 5; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
  });

  test('用例 8：无敌 A 撞墙照样死', () => {
    const a = straight('a', 60, 600);
    a.angle = Math.PI;
    a.targetAngle = Math.PI;
    a.invincibleUntil = now + 5000;
    const state = makeState([a], [], { variant: 'endless' });
    // 60px → 撞墙要跑 ~44px，125px/s 每 tick 6.25px，给足 12 tick
    for (let i = 0; i < 12 && a.alive; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.alive).toBe(false);
  });

  // ---------- 9 同队 ----------
  test('用例 9：同队 A 撞 B 身体 → 都不死', () => {
    const a = straight('a', 320, 300);
    a.team = '红队';
    const b = snakeFromPath('b', [[340, 200], [340, 400]]);
    b.team = '红队';
    const state = makeState([a, b], [], { variant: 'team' });
    for (let i = 0; i < 5; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
  });

  // ---------- 10 食物 ----------
  test('用例 10：吃小/中/大食物 → 分数 +6/+18/+36，长度 +18/+54/+108', () => {
    for (const tier of SNAKE_FOOD_TIERS) {
      const a = straight('p1', 600, 600);
      const state = makeState([a], [foodAt(606, 600, tier.value)], { variant: 'endless' });
      stepSnake(state, { dt: STEP, now });
      expect(a.score).toBe(tier.value);
      expect(a.length).toBe(SNAKE_BODY_LENGTH + tier.value * SNAKE_GROW_PER_SCORE);
    }
  });

  // ---------- 11 磁铁 ----------
  test('用例 11：磁铁把 220px 内非道具拉过来，再吃刷新为 6s', () => {
    const a = straight('p1', 600, 600);
    const farX = 600 + SNAKE_MAGNET_RADIUS + 40;
    const far = foodAt(farX, 600);
    const near = foodAt(600 + 200, 600);
    const state = makeState([a], [itemAt(600, 600, SNAKE_KIND_MAGNET), far, near], { variant: 'endless' });
    // 第 1 tick：磁铁被吃掉（吸附在吃判定之前，故本 tick 还不生效）
    stepSnake(state, { dt: STEP, now });
    expect(a.magnetUntil).toBe(now + 6000);
    // 第 2 tick：220px 内的食物被拉向蛇头，220px 外的不动
    const before = state.food.find(f => f.id === near.id);
    const nearX = before?.x ?? NaN;
    stepSnake(state, { dt: STEP, now: now + 50 });
    expect(state.food.find(f => f.id === near.id)?.x).toBeLessThan(nearX);
    expect(state.food.find(f => f.id === far.id)?.x ?? farX).toBe(farX);
    // 刷新式：过期前再吃一颗，重置为完整 6s
    const later = now + 4000;
    state.food.push(itemAt(a.x, a.y, SNAKE_KIND_MAGNET));
    stepSnake(state, { dt: STEP, now: later });
    expect(a.magnetUntil).toBe(later + 6000);
  });

  // ---------- 12 星星 ----------
  test('用例 12：星星免疫身体与头对头、不免墙；再吃刷新 2.5s', () => {
    const a = straight('a', 300, 300);
    const b = snakeFromPath('b', [[340, 200], [340, 400]]);
    const state = makeState([a, b], [itemAt(306, 300, SNAKE_KIND_STAR)], { variant: 'endless' });
    stepSnake(state, { dt: STEP, now });
    expect(a.invincibleUntil).toBe(now + 2500);
    // 无敌期间穿过 B 的身体（x=340）也不死
    for (let i = 0; i < 8; i++) stepSnake(state, { dt: STEP, now: now + (i + 1) * 50 });
    expect(a.alive).toBe(true);
    // 刷新式
    const later = now + 1000;
    state.food.push(itemAt(a.x, a.y, SNAKE_KIND_STAR));
    stepSnake(state, { dt: STEP, now: later });
    expect(a.invincibleUntil).toBe(later + 2500);
    // 不免墙
    a.invincibleUntil = later + 10_000;
    a.angle = Math.PI;
    a.targetAngle = Math.PI;
    for (let i = 0; i < 400 && a.alive; i++) stepSnake(state, { dt: STEP, now: later + i * 50 });
    expect(a.alive).toBe(false);
  });

  // ---------- 13/14 加速 ----------
  test('用例 13：按住加速 1s → 速度 314.5，长度扣 18px，松开立即恢复', () => {
    const a = straight('p1', 500, 700, 400);
    const state = makeState([a], [], { variant: 'endless' });
    expect(setBoost(state, 'p1', true)).toBe(true);
    for (let i = 0; i < 20; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.x - 500).toBeCloseTo(SNAKE_SPEED * SNAKE_BOOST_MULT * 1, 1);
    expect(400 - a.length).toBeCloseTo(SNAKE_BOOST_DRAIN * 1, 1);

    const before = a.x;
    setBoost(state, 'p1', false);
    stepSnake(state, { dt: STEP, now: now + 1000 });
    expect(a.x - before).toBeCloseTo(SNAKE_SPEED * STEP, 1);
  });

  test('用例 14：长度 130 按住加速 → 扣到 120 自动停，不会更低', () => {
    const a = straight('p1', 500, 700, SNAKE_BOOST_MIN_LEN + 10);
    const state = makeState([a], [], { variant: 'endless' });
    setBoost(state, 'p1', true);
    for (let i = 0; i < 40; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(a.length).toBe(SNAKE_BOOST_MIN_LEN);
    expect(a.boostHeld).toBe(false);
  });

  // ---------- 15/16 残骸 ----------
  test('用例 15：死亡 score=2000 → 残骸总价值 ≤ 1800、单颗 ≤ 45、数量 ∈ [4,64]', () => {
    const a = straight('a', 320, 300, SNAKE_MAX_LENGTH);
    a.score = 2000;
    const b = snakeFromPath('b', [[340, 200], [340, 400]]);
    const state = makeState([a, b], [], { variant: 'endless' });
    for (let i = 0; i < 3 && a.alive; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    const corpses = state.food.filter(f => f.k === SNAKE_KIND_CORPSE);
    expect(corpses.length).toBeGreaterThanOrEqual(SNAKE_CORPSE_MIN);
    expect(corpses.length).toBeLessThanOrEqual(SNAKE_CORPSE_MAX);
    expect(corpses.reduce((sum, f) => sum + f.v, 0)).toBeLessThanOrEqual(2000 * SNAKE_CORPSE_RATIO);
    for (const c of corpses) expect(c.v).toBeLessThanOrEqual(SNAKE_CORPSE_VALUE_MAX);
  });

  test('用例 16：残骸满 80 颗时高分段死亡 → 移除最低价值腾位置', () => {
    const a = straight('a', 320, 300, SNAKE_MAX_LENGTH);
    a.score = 2000;
    const b = snakeFromPath('b', [[340, 200], [340, 400]]);
    // 铺满 80 颗低价值残骸
    const full: SnakeFoodItem[] = [];
    for (let i = 0; i < SNAKE_CORPSE_FIELD_MAX; i++) {
      full.push({ id: 50_000 + i, x: 2000 + i * 30, y: 3000, r: 6, v: 1, k: SNAKE_KIND_CORPSE });
    }
    const state = makeState([a, b], full, { variant: 'endless' });
    for (let i = 0; i < 3 && a.alive; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    const corpses = state.food.filter(f => f.k === SNAKE_KIND_CORPSE);
    expect(corpses.length).toBeLessThanOrEqual(SNAKE_CORPSE_FIELD_MAX);
    const total = corpses.reduce((sum, f) => sum + f.v, 0);
    expect(total).toBeLessThanOrEqual(SNAKE_CORPSE_FIELD_CAP);
    // 低价值的先被清掉：场上仍有 1 分残骸但数量被控制在硬顶内
    expect(corpses.some(f => f.v > 1)).toBe(true);
  });

  // ---------- 17 无尽 ----------
  test('用例 17：无尽模式死亡 → status 仍 playing、over=false、respawnAt=0，可手动重生', () => {
    const a = straight('a', 60, 600);
    a.angle = Math.PI;
    a.targetAngle = Math.PI;
    const state = makeState([a], [], { variant: 'endless' });
    let over = false;
    for (let i = 0; i < 10 && a.alive; i++) {
      over = stepSnake(state, { dt: STEP, now: now + i * 50 }).over;
    }
    expect(a.alive).toBe(false);
    expect(state.status).toBe('playing');
    expect(over).toBe(false);
    expect(a.respawnAt).toBe(0);
    expect(respawnSnake(state, 'a', now, () => 0.5)).toBe(true);
    expect(a.alive).toBe(true);
    expect(a.invincibleUntil).toBe(now + SNAKE_INVINCIBLE_MS);
  });

  // ---------- 18 团队限时 ----------
  test('用例 18：团队 8 分钟到 → 总分最高队胜；同分比最高单蛇；再同平局', () => {
    const r1 = straight('r1', 1000, 1000);
    r1.team = '红队';
    r1.score = 100;
    const b1 = straight('b1', 2000, 2000);
    b1.team = '蓝队';
    b1.score = 80;

    const s1 = makeState([r1, b1], [], { variant: 'team', endsAt: now + SNAKE_TEAM_MATCH_MS });
    expect(s1.endsAt - now).toBe(480_000);
    const timed = makeState([r1, b1], [], { variant: 'team', endsAt: now - 1 });
    const res = stepSnake(timed, { dt: STEP, now });
    expect(res.over).toBe(true);
    expect(timed.status).toBe('over');
    expect(timed.winner).toBe('r1');

    // 同分 → 比各队最高单蛇
    const r2 = straight('r1', 1000, 1000);
    r2.team = '红队';
    r2.score = 80;
    const b2 = straight('b1', 2000, 2000);
    b2.team = '蓝队';
    b2.score = 80;
    b2.best = 90;
    const tieState = makeState([r2, b2], [], { variant: 'team', endsAt: now - 1 });
    stepSnake(tieState, { dt: STEP, now });
    expect(tieState.winner).toBe('b1');

    // 完全同分同最高 → 平局
    const r3 = straight('r1', 1000, 1000);
    r3.team = '红队';
    r3.score = 80;
    const b3 = straight('b1', 2000, 2000);
    b3.team = '蓝队';
    b3.score = 80;
    const drawState = makeState([r3, b3], [], { variant: 'team', endsAt: now - 1 });
    stepSnake(drawState, { dt: STEP, now });
    expect(drawState.winner).toBe('');
  });

  // ---------- 19 提前结束 ----------
  test('用例 19：团队仅剩一队 → 提前结束；全灭按 teamScores 判', () => {
    const r1 = straight('r1', 1000, 1000);
    r1.team = '红队';
    const b1 = straight('b1', 2000, 2000);
    b1.team = '蓝队';
    const onlyRed = makeState([r1, b1], [], { variant: 'team', endsAt: now + 480_000 });
    b1.alive = false;
    const res = stepSnake(onlyRed, { dt: STEP, now });
    expect(res.over).toBe(true);
    expect(onlyRed.winner).toBe('r1');

    const r2 = straight('r1', 1000, 1000);
    r2.team = '红队';
    r2.score = 50;
    const b2 = straight('b1', 2000, 2000);
    b2.team = '蓝队';
    b2.score = 10;
    const allDead = makeState([r2, b2], [], { variant: 'team', endsAt: now + 480_000 });
    r2.alive = false;
    b2.alive = false;
    stepSnake(allDead, { dt: STEP, now });
    expect(allDead.winner).toBe('r1');
  });

  // ---------- 其它不变量 ----------
  test('吃食物后补位：每 tick 最多补 1 颗，总量不超过目标', () => {
    const a = straight('p1', 600, 600);
    const state = makeState([a], [], { variant: 'endless' });
    stepSnake(state, { dt: STEP, now });
    expect(state.food.filter(f => f.k === SNAKE_KIND_FOOD).length).toBe(1);
    for (let i = 0; i < 200; i++) stepSnake(state, { dt: STEP, now: now + i * 50 });
    expect(state.food.filter(f => f.k === SNAKE_KIND_FOOD).length).toBeLessThanOrEqual(SNAKE_FOOD_COUNT);
  });

  test('spawnFood / spawnItem 各自带唯一 id 且递增', () => {
    const state = makeState([], [], { variant: 'endless' });
    const seq = () => { let n = 0; return () => ((n = (n * 9301 + 49297) % 233280) / 233280); };
    const f1 = spawnFood(state, seq());
    const f2 = spawnItem(state, seq());
    expect(f1 && f2).toBeTruthy();
    expect(f2!.id).toBeGreaterThan(f1!.id);
    expect([SNAKE_KIND_FOOD, SNAKE_KIND_MAGNET, SNAKE_KIND_STAR]).toContain(f2!.k);
  });

  test('分数表取历史最高（跨重生不丢分）', () => {
    const a = straight('p1', 600, 600);
    a.score = 10;
    a.best = 120;
    const state = makeState([a], [], { variant: 'endless' });
    expect(snakeScores(state)).toEqual({ p1: 120 });
  });
});
