import { describe, test, expect } from 'bun:test';
import {
  SNAKE_BOOST_CD_MS,
  SNAKE_BOOST_MS,
  SNAKE_BOOST_MULT,
  SNAKE_BODY_LENGTH,
  SNAKE_CORPSE_FIELD_CAP,
  SNAKE_CORPSE_MIN,
  SNAKE_CORPSE_RATIO,
  SNAKE_FOOD_COUNT,
  SNAKE_FOOD_SCORE,
  SNAKE_FOOD_TIERS,
  SNAKE_GROW_PER_SCORE,
  SNAKE_INVINCIBLE_MS,
  SNAKE_ITEM_COUNT,
  SNAKE_KIND_CORPSE,
  SNAKE_KIND_FOOD,
  SNAKE_KIND_LIGHTNING,
  SNAKE_KIND_MAGNET,
  SNAKE_LIGHTNING_MS,
  SNAKE_LIGHTNING_MULT,
  SNAKE_MAGNET_MS,
  SNAKE_MAGNET_RADIUS,
  SNAKE_MIN_TURN_RADIUS,
  SNAKE_PATH_STEP,
  SNAKE_RADIUS,
  SNAKE_SEG_SPACING,
  SNAKE_SPEED,
  SNAKE_TURN_RATE,
  SNAKE_WORLD_H,
  SNAKE_WORLD_W,
  boostSnake,
  createSnakeState,
  normalizeAngle,
  respawnSnake,
  snakeScores,
  snakeSpine,
  spawnFood,
  spawnItem,
  steerSnake,
  stepSnake,
  type SnakeFoodItem,
  type SnakePlayerState,
  type SnakeState,
} from '../src/games/snake/rules';

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

/** 三点外接圆半径（用来验证盘旋半径） */
function circumRadius(a: [number, number], b: [number, number], c: [number, number]): number {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  return area < 1e-9 ? Infinity : (ab * bc * ca) / (4 * area);
}

/** 用折线造一条蛇：points[0] 是蛇头，身体朝 points[1] 反方向铺开 */
function snakeFromPath(id: string, points: [number, number][], length?: number): SnakePlayerState {
  const path = densify(points);
  const [x, y] = path[0];
  const next = path[1] || path[0];
  // 身体在身后 → 朝向与"指向身体"相反
  const angle = normalizeAngle(Math.atan2(y - next[1], x - next[0]));
  const total = pathLength(path);
  return {
    id,
    x,
    y,
    angle,
    targetAngle: angle,
    path,
    length: length ?? total,
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
    team: '',
  };
}

/** 一条朝右的直蛇（头在 x,y，身体向左铺 length 像素） */
const straight = (id: string, x: number, y: number, length = SNAKE_BODY_LENGTH) =>
  snakeFromPath(id, [[x, y], [x - length, y]], length);

function makeState(
  snakes: SnakePlayerState[],
  food: SnakeFoodItem[] = [],
  opts: { variant?: 'endless' | 'team'; w?: number; h?: number } = {},
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
  };
}

/** 造一颗普通食物 */
const foodAt = (x: number, y: number, value = SNAKE_FOOD_SCORE): SnakeFoodItem => ({
  x, y,
  r: value >= 20 ? 11 : (value >= 8 ? 8 : 5),
  v: value,
  k: SNAKE_KIND_FOOD,
});

/** 造一个道具 */
const itemAt = (x: number, y: number, kind: number): SnakeFoodItem => ({
  x, y, r: 9, v: 0, k: kind,
});

describe('贪吃蛇规则（连续像素）', () => {
  test('建局：世界远大于视口、蛇在界内且留出跑道、食物数量正确且不压身', () => {
    const state = createSnakeState(['p1', 'p2', 'p3'], { foodCount: 20, itemCount: 0 });
    expect(state.w).toBe(SNAKE_WORLD_W);
    expect(state.h).toBe(SNAKE_WORLD_H);
    expect(state.snakes.length).toBe(3);
    for (const s of state.snakes) {
      expect(s.alive).toBe(true);
      expect(s.x).toBeGreaterThan(120);
      expect(s.x).toBeLessThan(state.w - 120);
      expect(s.y).toBeGreaterThan(120);
      expect(s.y).toBeLessThan(state.h - 120);
      // 初始路径就是一条长度 ~SNAKE_BODY_LENGTH 的直线
      expect(pathLength(s.path)).toBeCloseTo(SNAKE_BODY_LENGTH, 0);
      expect(s.path[0][0]).toBeCloseTo(s.x, 5);
    }
    expect(state.food.length).toBe(20);
    for (const f of state.food) {
      for (const s of state.snakes) {
        for (let i = 0; i < s.path.length; i += 3) {
          expect(Math.hypot(s.path[i][0] - f.x, s.path[i][1] - f.y)).toBeGreaterThan(SNAKE_RADIUS);
        }
      }
    }
  });

  test('移动是连续的：一个 tick 走 speed×dt 像素，不是跳一格', () => {
    const state = makeState([straight('p1', 300, 300)]);
    state.variant = 'endless';
    const before = state.snakes[0].x;
    stepSnake(state, { dt: 0.1, now: 0 });
    // 170px/s × 0.1s = 17px（允许浮点误差）
    expect(state.snakes[0].x - before).toBeGreaterThan(SNAKE_SPEED * 0.1 - 0.5);
    expect(state.snakes[0].x - before).toBeLessThan(SNAKE_SPEED * 0.1 + 0.5);
    expect(state.snakes[0].y).toBeCloseTo(300, 1);
    expect(state.tick).toBe(1);
  });

  test('任意角度转向：受最大角速度限制，最终能停在任意目标角', () => {
    const state = makeState([straight('p1', 600, 600, 60)]);
    state.variant = 'endless';
    expect(steerSnake(state, 'p1', 0.7)).toBe(true);

    // 单个 tick 只转一点点
    stepSnake(state, { dt: 0.05, now: 0 });
    expect(state.snakes[0].angle).toBeCloseTo(SNAKE_TURN_RATE * 0.05, 3);

    // 转够时间后精确停在目标角（不是四方向）
    for (let i = 0; i < 20; i++) stepSnake(state, { dt: 0.05, now: 0 });
    expect(state.snakes[0].angle).toBeCloseTo(0.7, 3);
  });

  test('吃食物：加分、按像素变长、吃掉的食物消失并补一颗', () => {
    const state = makeState([straight('p1', 300, 300)], [foodAt(320, 300)]);
    state.variant = 'endless';
    const before = state.food.length;
    const res = stepSnake(state, { dt: 0.15, now: 0 });
    expect(res.ate).toEqual(['p1']);
    expect(state.snakes[0].score).toBe(SNAKE_FOOD_SCORE);
    expect(state.snakes[0].length).toBe(SNAKE_BODY_LENGTH + SNAKE_FOOD_SCORE * SNAKE_GROW_PER_SCORE);
    expect(state.food.length).toBe(before); // 吃一颗补一颗
    expect(state.food.some(f => f.x === 320 && f.y === 300)).toBe(false);
  });

  test('撞墙按半径判定', () => {
    const state = makeState([straight('p1', SNAKE_WORLD_W - 30, 300)], [], { variant: 'endless' });
    const res = stepSnake(state, { dt: 0.25, now: 0 });
    expect(res.died).toEqual(['p1']);
    expect(state.snakes[0].alive).toBe(false);
    // 无尽模式对局不结束
    expect(res.over).toBe(false);
  });

  test('撞别人身体：压上去必死，擦身而过不误判', () => {
    // B 的身体竖在 x=320，覆盖 y∈[260,380]
    const bPath: [number, number][] = [[320, 380], [320, 260]];

    const hit = makeState([straight('a', 300, 300, 60), snakeFromPath('b', bPath)]);
    stepSnake(hit, { dt: 0.2, now: 0 });
    expect(hit.snakes.find(s => s.id === 'a')?.alive).toBe(false);

    // 同一条 B，但整体下移到 y∈[355,475]：a 从 y=300 直行，擦身而过
    const miss = makeState([
      straight('a', 300, 300, 60),
      snakeFromPath('b', [[320, 475], [320, 355]]),
    ]);
    stepSnake(miss, { dt: 0.2, now: 0 });
    expect(miss.snakes.find(s => s.id === 'a')?.alive).toBe(true);
  });

  test('头对头：等长才双双淘汰，按分数决胜', () => {
    const state = makeState([
      straight('a', 300, 300, 60),
      snakeFromPath('b', [[360, 300], [420, 300]]), // 头朝左
    ]);
    state.snakes[0].score = 30;
    state.snakes[1].score = 10;
    const res = stepSnake(state, { dt: 0.2, now: 0 });
    expect(res.died.sort()).toEqual(['a', 'b']);
    expect(res.over).toBe(true);
    expect(state.winner).toBe('a');
    expect(snakeScores(state)).toEqual({ a: 30, b: 10 });
  });

  test('头对头：长的活、短的死（不再两条一起死）', () => {
    // a 身长 60，b 身长 120，两头对撞
    const state = makeState([
      straight('a', 300, 300, 60),
      snakeFromPath('b', [[360, 300], [480, 300]]),
    ]);
    const res = stepSnake(state, { dt: 0.2, now: 0 });
    expect(res.died).toEqual(['a']);
    expect(state.snakes.find(s => s.id === 'b')?.alive).toBe(true);
  });

  test('同向并行：蛇头挨得再近也不算对撞', () => {
    // 两条蛇都朝右、蛇头横向只差 24px（< 2×SNAKE_HEAD_RADIUS=26，旧规则判"头对头"双亡），
    // 但身体中心线相距 24 > SNAKE_HIT_R(22.6)，并没有真的压在一起 → 谁都不该死。
    const state = makeState([
      straight('a', 300, 300, 60),
      straight('b', 300, 324, 60),
    ], [], { variant: 'endless' });
    const res = stepSnake(state, { dt: 0.2, now: 0 });
    expect(res.died).toEqual([]);
  });

  test('压上对方身体只死撞的一方，不连带被撞的', () => {
    // b 的蛇头停在 a 正前方（距离 < 26px，旧规则会判定"头对头"双亡），
    // 但 b 往上走、根本没朝 a 靠近 —— 是 a 主动压上了 b 的身体
    const state = makeState([
      straight('a', 300, 300, 60),
      snakeFromPath('b', [[350, 300], [350, 420], [300, 460]]),
    ], [], { variant: 'endless' });
    const res = stepSnake(state, { dt: 0.2, now: 0 });
    expect(res.died).toEqual(['a']);
    expect(state.snakes.find(s => s.id === 'b')?.alive).toBe(true);
  });

  test('无敌只免疫别人；蛇头可以穿过自己的身体', () => {
    // a 有盾，撞 b 的身体
    const shielded = makeState(
      [straight('a', 300, 300, 60), snakeFromPath('b', [[320, 380], [320, 260]])],
      [],
      { variant: 'endless' },
    );
    shielded.snakes[0].invincibleUntil = 5000;
    stepSnake(shielded, { dt: 0.2, now: 1000 });
    expect(shielded.snakes.find(s => s.id === 'a')?.alive).toBe(true);

    // 同一张盘起来的身体：蛇头从自己身上压过去也不死（有盾 / 没盾都一样）
    const curled = () => makeState([snakeFromPath('p1', [
      [300, 300], [360, 300], [380, 340], [360, 380],
      [300, 380], [250, 380], [230, 340], [250, 300], [283, 300],
    ])], [], { variant: 'endless' });

    const selfHit = curled();
    selfHit.snakes[0].invincibleUntil = 5000;
    stepSnake(selfHit, { dt: 0.1, now: 1000 });
    expect(selfHit.snakes[0].alive).toBe(true);

    const plain = curled();
    stepSnake(plain, { dt: 0.1, now: 1000 });
    expect(plain.snakes[0].alive).toBe(true);
  });

  test('最小转弯半径：一直侧向瞄准也只绕 26px 的小圈，不会原地自转', () => {
    const state = makeState([straight('p1', 900, 900)], [], { variant: 'endless' });
    const s = state.snakes[0];
    const pts: [number, number][] = [];
    // 每 tick 都瞄准"正侧方"：稳态就是以最大角速度盘旋
    for (let i = 0; i < 120; i++) {
      steerSnake(state, 'p1', s.angle + Math.PI / 2);
      stepSnake(state, { dt: 0.05, now: i * 50 });
      pts.push([s.x, s.y]);
    }
    const r = circumRadius(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]);
    expect(r).toBeGreaterThan(SNAKE_MIN_TURN_RADIUS - 2);
    expect(r).toBeLessThan(SNAKE_MIN_TURN_RADIUS + 2);
    // 角速度就是 v / R（半径恒定，速度越快转得越快）
    expect(SNAKE_TURN_RATE).toBeCloseTo(SNAKE_SPEED / SNAKE_MIN_TURN_RADIUS, 6);
  });

  test('加速：速度按倍数提升，加速中/冷却中不能再次触发', () => {
    const build = () => {
      const s = makeState([straight('p1', 500, 500)]);
      s.variant = 'endless';
      return s;
    };
    const now = 10_000;

    const normal = build();
    stepSnake(normal, { dt: 0.1, now });

    const boosted = build();
    expect(boostSnake(boosted, 'p1', now)).toBe(true);
    // 3s 冲刺 / 1 分钟冷却
    expect(boosted.snakes[0].boostUntil - now).toBe(SNAKE_BOOST_MS);
    expect(boosted.snakes[0].boostReadyAt - now).toBe(SNAKE_BOOST_CD_MS);
    expect(SNAKE_BOOST_MS).toBe(3000);
    expect(SNAKE_BOOST_CD_MS).toBe(60_000);
    stepSnake(boosted, { dt: 0.1, now });

    const dNormal = normal.snakes[0].x - 500;
    const dBoost = boosted.snakes[0].x - 500;
    expect(dBoost / dNormal).toBeCloseTo(SNAKE_BOOST_MULT, 1);

    expect(boostSnake(boosted, 'p1', now + 100)).toBe(false); // 正在加速
    expect(boostSnake(boosted, 'p1', now + SNAKE_BOOST_MS + 100)).toBe(false); // 冷却中
    expect(boostSnake(boosted, 'p1', now + SNAKE_BOOST_CD_MS + 10)).toBe(true); // 冷却结束
  });

  test('无尽模式：死亡不结束对局，停在"等你选择"（不会自动重生）', () => {
    const state = makeState([straight('p1', SNAKE_WORLD_W - 30, 300)], [], { variant: 'endless' });
    state.snakes[0].score = 40;
    state.snakes[0].best = 40;
    stepSnake(state, { dt: 0.25, now: 0 });
    expect(state.snakes[0].alive).toBe(false);
    expect(state.status).toBe('playing');
    // 等再久也不会自己活过来：重生必须由玩家在弹框里点按钮触发
    const later = 60_000;
    const res = stepSnake(state, { dt: 0.05, now: later });
    expect(res.respawned).toEqual([]);
    expect(state.snakes[0].alive).toBe(false);
    // 分数保留到重生那一刻（弹框要显示，且死亡时已记榜）
    expect(state.snakes[0].score).toBe(40);

    expect(respawnSnake(state, 'p1', later)).toBe(true);
    const s = state.snakes[0];
    expect(s.alive).toBe(true);
    expect(s.score).toBe(0);
    expect(s.best).toBe(40);
    expect(s.respawns).toBe(1);
    expect(s.invincibleUntil).toBe(later + SNAKE_INVINCIBLE_MS);
    expect(s.length).toBe(SNAKE_BODY_LENGTH);
  });

  test('重生：手动调用也落在空白处、朝向合法、长度复位', () => {
    const state = makeState([straight('p1', 300, 300)], [], { variant: 'endless' });
    state.snakes[0].alive = false;
    state.snakes[0].respawnAt = 100;
    expect(respawnSnake(state, 'p1', 200)).toBe(true);
    const s = state.snakes[0];
    expect(s.alive).toBe(true);
    expect(s.x).toBeGreaterThan(120);
    expect(s.x).toBeLessThan(state.w - 120);
    expect(s.angle).toBeCloseTo(normalizeAngle(s.angle), 6);
    expect(pathLength(s.path)).toBeCloseTo(SNAKE_BODY_LENGTH, 0);
  });

  test('网络采样：从蛇头等距取点，点数随身长增长', () => {
    const state = makeState([straight('p1', 300, 300, 200)]);
    const s = state.snakes[0];
    const pts = snakeSpine(s);
    expect(pts[0][0]).toBeCloseTo(s.x, 0);
    expect(pts[0][1]).toBeCloseTo(s.y, 0);
    expect(pts.length).toBe(Math.floor(200 / SNAKE_SEG_SPACING) + 1);
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      expect(d).toBeGreaterThan(SNAKE_SEG_SPACING - 1.5);
      expect(d).toBeLessThan(SNAKE_SEG_SPACING + 1.5);
    }
  });

  test('默认食物数量常量与建局一致', () => {
    const state = createSnakeState(['p1']);
    const foods = state.food.filter(f => f.k === SNAKE_KIND_FOOD);
    const items = state.food.filter(f => f.k !== SNAKE_KIND_FOOD);
    expect(foods.length).toBe(SNAKE_FOOD_COUNT);
    expect(items.length).toBe(SNAKE_ITEM_COUNT);
  });
});

describe('贪吃蛇团队模式（6 队 × 每队 5 人）', () => {
  test('建局：队伍映射写入每条蛇，同队同色', () => {
    const state = createSnakeState(
      ['p1', 'p2', 'p3'],
      { variant: 'team', teams: { p1: '红队', p2: '红队', p3: '蓝队' } },
    );
    expect(state.variant).toBe('team');
    expect(state.snakes.find(s => s.id === 'p1')?.team).toBe('红队');
    expect(state.snakes.find(s => s.id === 'p2')?.team).toBe('红队');
    expect(state.snakes.find(s => s.id === 'p3')?.team).toBe('蓝队');
  });

  test('队友之间不互相碰撞致死（撞到队友身体仍存活）', () => {
    // p1 头在 300,300 朝右；p2（队友）身体横在 p1 正前方
    const p1 = straight('p1', 300, 300, 120);
    const p2 = straight('p2', 360, 300, 120);
    p2.team = '红队';
    p1.team = '红队';
    const state = makeState([p1, p2], [], { variant: 'team' });
    const result = stepSnake(state, { dt: 0.05, now: 1000 });
    expect(result.died).not.toContain('p1');
    expect(state.snakes.find(s => s.id === 'p1')?.alive).toBe(true);
  });

  test('异队之间照常碰撞致死', () => {
    const p1 = straight('p1', 300, 300, 120);
    const p2 = straight('p2', 360, 300, 120);
    p1.team = '红队';
    p2.team = '蓝队';
    const state = makeState([p1, p2], [], { variant: 'team' });
    const result = stepSnake(state, { dt: 0.05, now: 1000 });
    expect(result.died).toContain('p1');
  });

  test('一支队伍全员出局即淘汰，只剩一队时该队获胜', () => {
    const a1 = straight('a1', 300, 300);
    const a2 = straight('a2', 400, 300);
    const b1 = straight('b1', 900, 900);
    a1.team = '红队'; a2.team = '红队'; b1.team = '蓝队';
    const state = makeState([a1, a2, b1], [], { variant: 'team' });
    // 红队两人直接判死（模拟被撞/出局），蓝队还活着
    a1.alive = false;
    a2.alive = false;
    const result = stepSnake(state, { dt: 0.05, now: 1000 });
    expect(result.over).toBe(true);
    expect(state.status).toBe('over');
    expect(state.winner).toBe('b1');
  });

  test('队伍总积分：队内成员最高分之和', () => {
    const state = makeState(
      [straight('a1', 300, 300), straight('a2', 400, 300), straight('b1', 900, 900)],
      [],
      { variant: 'team' },
    );
    state.snakes[0].team = '红队'; state.snakes[0].score = 30; state.snakes[0].best = 30;
    state.snakes[1].team = '红队'; state.snakes[1].score = 20; state.snakes[1].best = 20;
    state.snakes[2].team = '蓝队'; state.snakes[2].score = 10; state.snakes[2].best = 10;
    const result = stepSnake(state, { dt: 0.05, now: 1000 });
    expect(result.over).toBe(false);
    expect(state.teamScores).toEqual({ 红队: 50, 蓝队: 10 });
  });
});

describe('贪吃蛇：食物分档', () => {
  test('小的数量多、大的数量少：按权重抽样，三档数量递减', () => {
    // 大世界避免"位置放不下"导致的抽样偏差
    const state = createSnakeState(['p1'], { width: 9000, height: 7000, foodCount: 0, itemCount: 0 });
    for (let i = 0; i < 1500; i++) spawnFood(state);
    const foods = state.food.filter(f => f.k === SNAKE_KIND_FOOD);
    const counts = SNAKE_FOOD_TIERS.map(t => foods.filter(f => f.v === t.value).length);
    // 小档最多、大档最少
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThan(counts[2]);
    // 大档占比接近 12% 的权重
    expect(counts[2] / foods.length).toBeGreaterThan(0.08);
    expect(counts[2] / foods.length).toBeLessThan(0.16);
  });

  test('每颗食物的半径与分值对应档位（大食物更值钱也更大）', () => {
    const state = createSnakeState(['p1'], { foodCount: 0, itemCount: 0 });
    for (let i = 0; i < 200; i++) spawnFood(state);
    for (const f of state.food) {
      const tier = SNAKE_FOOD_TIERS.find(t => t.value === f.v)!;
      expect(tier).toBeTruthy();
      expect(f.r).toBe(tier.radius);
    }
  });

  test('大食物收益更高：加分更多、身体更长', () => {
    const small = makeState([straight('p1', 300, 300)], [foodAt(320, 300, 5)], { variant: 'endless' });
    const big = makeState([straight('p1', 300, 300)], [foodAt(320, 300, 30)], { variant: 'endless' });
    stepSnake(small, { dt: 0.15, now: 0 });
    stepSnake(big, { dt: 0.15, now: 0 });
    expect(big.snakes[0].score).toBeGreaterThan(small.snakes[0].score);
    expect(big.snakes[0].length).toBeGreaterThan(small.snakes[0].length);
  });
});

describe('贪吃蛇：道具（磁铁 / 闪电）', () => {
  test('道具不加长度、不加分，只给特殊效果', () => {
    const state = makeState(
      [straight('p1', 300, 300)],
      [itemAt(320, 300, SNAKE_KIND_MAGNET), itemAt(340, 300, SNAKE_KIND_LIGHTNING)],
      { variant: 'endless' },
    );
    const now = 5_000;
    stepSnake(state, { dt: 0.15, now });
    const s = state.snakes[0];
    expect(s.score).toBe(0);
    expect(s.length).toBe(SNAKE_BODY_LENGTH);
    expect(s.magnetUntil).toBe(now + SNAKE_MAGNET_MS);
    expect(s.lightningUntil).toBe(now + SNAKE_LIGHTNING_MS);
    // 道具吃完要补位（否则场上道具会越来越少）：数量不变，类型随机
    const items = state.food.filter(f => f.k === SNAKE_KIND_MAGNET || f.k === SNAKE_KIND_LIGHTNING);
    expect(items.length).toBe(2);
  });

  test('磁铁：半径内的食物被拉向蛇头，半径外的不动', () => {
    const state = makeState(
      [straight('p1', 300, 300)],
      [foodAt(400, 300), foodAt(700, 300)],
      { variant: 'endless' },
    );
    state.snakes[0].magnetUntil = 10_000;
    const near = state.food[0];
    const far = state.food[1];
    const nearX0 = near.x;
    const farX0 = far.x;
    stepSnake(state, { dt: 0.05, now: 9_999 });
    expect(near.x).toBeLessThan(nearX0);          // 被拉过来
    expect(far.x).toBe(farX0);                     // 太远，不受影响
    expect(Math.hypot(near.x - state.snakes[0].x, near.y - state.snakes[0].y))
      .toBeLessThan(SNAKE_MAGNET_RADIUS);
  });

  test('闪电：速度小幅提升 1.35 倍', () => {
    const build = () => {
      const st = makeState([straight('p1', 500, 500)], [], { variant: 'endless' });
      return st;
    };
    const now = 10_000;
    const normal = build();
    stepSnake(normal, { dt: 0.1, now });
    const zapped = build();
    zapped.snakes[0].lightningUntil = now + 5_000;
    stepSnake(zapped, { dt: 0.1, now });
    const dNormal = normal.snakes[0].x - 500;
    const dZapped = zapped.snakes[0].x - 500;
    expect(dZapped / dNormal).toBeCloseTo(SNAKE_LIGHTNING_MULT, 2);
  });

  test('主动加速优先于闪电（不叠加倍率）', () => {
    const build = () => makeState([straight('p1', 500, 500)], [], { variant: 'endless' });
    const now = 10_000;
    const both = build();
    both.snakes[0].lightningUntil = now + 5_000;
    both.snakes[0].boostUntil = now + 5_000;
    stepSnake(both, { dt: 0.1, now });
    const normal = build();
    stepSnake(normal, { dt: 0.1, now });
    const dBoth = both.snakes[0].x - 500;
    const dNormal = normal.snakes[0].x - 500;
    expect(dBoth / dNormal).toBeCloseTo(SNAKE_BOOST_MULT, 2);
  });
});

describe('贪吃蛇：尸体残骸与能量收敛', () => {
  test('蛇死后留下残骸：数量随身长增长、总价值 = 分数 × 0.9', () => {
    const state = makeState([straight('p1', SNAKE_WORLD_W - 30, 300)], [], { variant: 'endless' });
    const s = state.snakes[0];
    s.score = 200;
    s.best = 200;
    s.length = 300;
    stepSnake(state, { dt: 0.25, now: 0 });
    expect(s.alive).toBe(false);

    const corpses = state.food.filter(f => f.k === SNAKE_KIND_CORPSE);
    expect(corpses.length).toBeGreaterThanOrEqual(SNAKE_CORPSE_MIN);
    const total = corpses.reduce((a, f) => a + f.v, 0);
    // 严格不变量：残骸总价值不超过 分数 × ρ
    expect(total).toBeLessThanOrEqual(Math.floor(200 * SNAKE_CORPSE_RATIO));
    // 也基本贴近（均摊取整误差在 ±10% 内）
    expect(total).toBeGreaterThan(Math.floor(200 * SNAKE_CORPSE_RATIO) * 0.9);
  });

  test('蛇越大 → 尸体越多、越值钱', () => {
    const build = (len: number) => {
      const st = makeState([straight('p1', SNAKE_WORLD_W - 30, 300)], [], { variant: 'endless' });
      st.snakes[0].score = 300;
      st.snakes[0].length = len;
      stepSnake(st, { dt: 0.25, now: 0 });
      const cs = st.food.filter(f => f.k === SNAKE_KIND_CORPSE);
      return { count: cs.length, total: cs.reduce((a, f) => a + f.v, 0) };
    };
    const small = build(120);
    const big = build(800);
    expect(big.count).toBeGreaterThan(small.count);
    expect(big.total).toBeGreaterThan(small.total);
  });

  test('残骸被吃光后不补位（不复制能量，否则总能量会发散）', () => {
    const state = makeState([straight('p1', 300, 300)], [], { variant: 'endless' });
    state.snakes[0].length = 200;
    // 手动放一颗残骸在蛇头前方
    state.food.push({ x: 320, y: 300, r: 8, v: 10, k: SNAKE_KIND_CORPSE });
    const before = state.food.length;
    stepSnake(state, { dt: 0.15, now: 0 });
    expect(state.food.length).toBe(before - 1); // 吃完就没了，不补
    expect(state.snakes[0].score).toBe(10);
  });

  test('场上残骸总价值有硬顶（世界总能量不会无限膨胀）', () => {
    const state = makeState([straight('p1', SNAKE_WORLD_W - 30, 300)], [], { variant: 'endless' });
    // 造一条巨蛇并给巨额分数，残骸总价值仍不得超过场上硬顶
    state.snakes[0].score = 999_999;
    state.snakes[0].length = 5000;
    stepSnake(state, { dt: 0.25, now: 0 });
    const total = state.food.filter(f => f.k === SNAKE_KIND_CORPSE).reduce((a, f) => a + f.v, 0);
    expect(total).toBeLessThanOrEqual(SNAKE_CORPSE_FIELD_CAP);
    // 且远小于原始分数（ρ ≤ 1 的收敛保证）
    expect(total).toBeLessThan(999_999);
  });

  test('收敛性：ρ = 0.9 时世界总放大倍数为 ρ/(1-ρ) = 9', () => {
    // 一代衰减 (1-ρ)，几何级数求和
    const rho = SNAKE_CORPSE_RATIO;
    expect(rho).toBeLessThan(1);
    expect(rho / (1 - rho)).toBeCloseTo(9, 5);
  });
});
