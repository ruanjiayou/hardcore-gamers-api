/**
 * 贪吃蛇可调参数（手感配置）。
 *
 * 设计要点：
 * - **唯一真相源在服务端**。客户端（lobby 预测、robot 决策）不再各自硬编码一份常量，
 *   改成从服务端快照里读 —— 否则改一次速度要改三个文件，漏一个就出现「蛇拉丝」
 *   （客户端预测与服务端权威值不一致）。
 * - **代码默认值 + 数据库覆盖**。`DEFAULT_SNAKE_PARAMS` 是代码里的兜底值；
 *   运营可以在管理端改 `games.config`（按游戏 slug 存），改完**下一局生效**。
 * - **建局时冻结**。参数在建局那一刻写进对局状态，之后整局不再变：
 *   中途改配置不会让同一局里前后半段手感突变，客户端也不会突然算出不一样的速度。
 *
 * 参数分组：
 * - 速度：巡航速度随身长线性递减（`speedMax` → `speedMin`），加速是倍率（`boostMult`）
 * - 转向：角速度 = 速度 / 最小转弯半径（`turnRadius` / `boostTurnRadius`）
 * - 体型：初始身长（`bodyLength`）、上限（`maxLength`）
 * - 加速代价：每秒扣身长（`boostDrain`）、可加速的最低身长（`boostMinLen`）
 */
export interface SnakeParams {
  /** 巡航最高速度（px/s）：身长 = 初始身长时的速度 */
  speedMax: number;
  /** 巡航最低速度（px/s）：身长 = 上限时速度 */
  speedMin: number;
  /** 加速倍率：加速速度 = 当前巡航速度 × 本值 */
  boostMult: number;
  /** 巡航最小转弯半径（px）：角速度 = 速度 / 半径 */
  turnRadius: number;
  /** 加速时最小转弯半径（px）：加速中更难拐弯 */
  boostTurnRadius: number;
  /** 初始身长（px） */
  bodyLength: number;
  /** 身长上限（px） */
  maxLength: number;
  /** 加速时每秒扣除的身长（px） */
  boostDrain: number;
  /** 可加速的最低身长（px）：低于此长度加速不生效 */
  boostMinLen: number;
}

/** 代码默认值：数据库没配时的兜底，也是新安装的初始值 */
export const DEFAULT_SNAKE_PARAMS: SnakeParams = {
  speedMax: 110,
  speedMin: 62,
  boostMult: 1.85,
  turnRadius: 25,
  boostTurnRadius: 52,
  bodyLength: 160,
  maxLength: 2400,
  boostDrain: 18,
  boostMinLen: 120,
};

/** 每个参数的合法区间：管理端校验 + 服务端兜底裁剪都用它 */
export const SNAKE_PARAM_RANGES: Record<keyof SnakeParams, { min: number; max: number }> = {
  speedMax: { min: 20, max: 400 },
  speedMin: { min: 10, max: 400 },
  boostMult: { min: 1, max: 5 },
  turnRadius: { min: 5, max: 200 },
  boostTurnRadius: { min: 5, max: 300 },
  bodyLength: { min: 20, max: 2000 },
  maxLength: { min: 200, max: 20000 },
  boostDrain: { min: 0, max: 200 },
  boostMinLen: { min: 0, max: 5000 },
};

/**
 * 参数元信息：管理端据此渲染表单（标签 / 合法区间 / 单位 / 说明）。
 *
 * **元信息也放在服务端** —— 前端不再自己维护一份字段清单，
 * 以后加参数只改这里，管理端表单自动多出一项。
 */
export interface SnakeParamMeta {
  key: keyof SnakeParams;
  /** 中文标签（管理端显示） */
  label: string;
  /** 分组（管理端按组分段显示） */
  group: string;
  /** 步进（管理端 number input 的 step） */
  step: number;
  /** 单位（管理端显示在输入框后面） */
  unit: string;
  /** 说明（管理端显示在输入框下面） */
  desc: string;
}

/** 参数元信息表（区间取自 `SNAKE_PARAM_RANGES`，不在这里重复写） */
export const SNAKE_PARAM_META: SnakeParamMeta[] = [
  { key: 'speedMax', label: '初始速度', group: '速度', step: 1, unit: 'px/s', desc: '蛇刚出生时的巡航速度。想整体调快/调慢，主要改这里。' },
  { key: 'speedMin', label: '满长速度', group: '速度', step: 1, unit: 'px/s', desc: '蛇长到身长上限时的巡航速度。速度在初始速度与本值之间按身长线性递减。' },
  { key: 'boostMult', label: '加速倍率', group: '速度', step: 0.05, unit: '×', desc: '加速时的速度 = 当前巡航速度 × 本值。1 表示加速不提速。' },
  { key: 'turnRadius', label: '巡航转弯半径', group: '转向', step: 1, unit: 'px', desc: '越小越灵活。角速度 = 速度 ÷ 本值。' },
  { key: 'boostTurnRadius', label: '加速转弯半径', group: '转向', step: 1, unit: 'px', desc: '加速时的最小转弯半径，通常大于巡航值（加速中更难拐弯）。' },
  { key: 'bodyLength', label: '初始身长', group: '体型', step: 10, unit: 'px', desc: '出生时的蛇身长度。' },
  { key: 'maxLength', label: '身长上限', group: '体型', step: 50, unit: 'px', desc: '吃食物后能达到的最大身长。' },
  { key: 'boostDrain', label: '加速消耗', group: '加速代价', step: 1, unit: 'px/s', desc: '加速时每秒扣除的身长。0 表示不消耗。' },
  { key: 'boostMinLen', label: '加速门槛', group: '加速代价', step: 10, unit: 'px', desc: '身长低于本值时加速不生效（按钮变灰）。' },
];

/**
 * 把任意来源（数据库 / 快照 / 旧对局）解析成一份合法的参数。
 *
 * - 缺字段 → 用代码默认值
 * - 数值非法（NaN / 越界）→ 裁剪到合法区间，而不是整个丢弃
 * - 交叉约束：`speedMin` 不能大于 `speedMax`；`boostMinLen` 不能大于 `bodyLength`；
 *   `maxLength` 不能小于 `bodyLength`。违反时按最小改动方向修正。
 */
export function resolveSnakeParams(raw: unknown): SnakeParams {
  const out: SnakeParams = { ...DEFAULT_SNAKE_PARAMS };
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SNAKE_PARAMS) as (keyof SnakeParams)[]) {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const range = SNAKE_PARAM_RANGES[key];
    out[key] = Math.min(range.max, Math.max(range.min, v));
  }
  // 交叉约束修正
  if (out.speedMin > out.speedMax) out.speedMin = out.speedMax;
  if (out.boostMinLen > out.bodyLength) out.boostMinLen = out.bodyLength;
  if (out.maxLength < out.bodyLength) out.maxLength = out.bodyLength;
  return out;
}

/** 参数是否与默认值完全一致（管理端用来提示「这个游戏还没改过配置」） */
export function isDefaultSnakeParams(raw: unknown): boolean {
  const p = resolveSnakeParams(raw);
  return (Object.keys(DEFAULT_SNAKE_PARAMS) as (keyof SnakeParams)[])
    .every(k => p[k] === DEFAULT_SNAKE_PARAMS[k]);
}
