import { describe, test, expect } from 'bun:test';
import {
  SNAKE_BOOST_CD_MS,
  SNAKE_BOOST_MS,
  SNAKE_BOOST_MULT,
  SNAKE_BODY_LENGTH,
  SNAKE_FOOD_COUNT,
  SNAKE_FOOD_SCORE,
  SNAKE_GROW_PER_FOOD,
  SNAKE_INVINCIBLE_MS,
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
  steerSnake,
  stepSnake,
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
    respawnAt: 0,
    respawns: 0,
  };
}

/** 一条朝右的直蛇（头在 x,y，身体向左铺 length 像素） */
const straight = (id: string, x: number, y: number, length = SNAKE_BODY_LENGTH) =>
  snakeFromPath(id, [[x, y], [x - length, y]], length);

function makeState(
  snakes: SnakePlayerState[],
  food: [number, number][] = [],
  opts: { variant?: 'endless' | 'multi'; w?: number; h?: number } = {},
): SnakeState {
  return {
    w: opts.w ?? SNAKE_WORLD_W,
    h: opts.h ?? SNAKE_WORLD_H,
    tick: 0,
    food: food.map(([x, y]) => [x, y] as [number, number]),
    snakes,
    status: 'playing',
    winner: '',
    variant: opts.variant ?? 'multi',
  };
}

describe('贪吃蛇规则（连续像素）', () => {
  test('建局：世界远大于视口、蛇在界内且留出跑道、食物数量正确且不压身', () => {
    const state = createSnakeState(['p1', 'p2', 'p3'], { foodCount: 20 });
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
    for (const [fx, fy] of state.food) {
      for (const s of state.snakes) {
        for (let i = 0; i < s.path.length; i += 3) {
          expect(Math.hypot(s.path[i][0] - fx, s.path[i][1] - fy)).toBeGreaterThan(SNAKE_RADIUS);
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
    const state = makeState([straight('p1', 300, 300)], [[320, 300]]);
    state.variant = 'endless';
    const before = state.food.length;
    const res = stepSnake(state, { dt: 0.15, now: 0 });
    expect(res.ate).toEqual(['p1']);
    expect(state.snakes[0].score).toBe(SNAKE_FOOD_SCORE);
    expect(state.snakes[0].length).toBe(SNAKE_BODY_LENGTH + SNAKE_GROW_PER_FOOD);
    expect(state.food.length).toBe(before); // 吃一颗补一颗
    expect(state.food.some(([x, y]) => x === 320 && y === 300)).toBe(false);
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

  test('头对头：双双淘汰，按分数决胜', () => {
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
    expect(state.food.length).toBe(SNAKE_FOOD_COUNT);
  });
});
