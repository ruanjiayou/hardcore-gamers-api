/**
 * 玩法参数的**规格登记表**（纯静态，不碰数据库）。
 *
 * 作用：把「某个游戏有哪些可调参数、合法区间多少、默认值多少」集中登记在一处。
 * 服务端建局、管理端表单、参数校验三条链路都读这张表 ——
 * 以后加一个可配置参数，只改这张表 + 对应游戏的 `params.ts`，三处自动同步。
 *
 * 与数据库无关（所以可以单独单测），读配置的活儿在 `services/GameParamsService.ts`。
 */
import {
  DEFAULT_SNAKE_PARAMS,
  SNAKE_PARAM_META,
  SNAKE_PARAM_RANGES,
  resolveSnakeParams,
  type SnakeParams,
} from './snake/params';

/** 参数元信息（管理端表单据此渲染：标签 / 区间 / 单位 / 说明） */
export interface GameParamMeta {
  key: string;
  label: string;
  group: string;
  step: number;
  unit: string;
  desc: string;
  min: number;
  max: number;
  /** 代码默认值 */
  default: number;
}

/** 一个游戏的参数规格 */
export interface GameParamSpec {
  /** 把任意输入解析成合法参数（缺字段补默认、越界裁剪、交叉约束修正） */
  resolver: (raw: unknown) => Record<string, number>;
  /** 代码默认值 */
  defaults: Record<string, number>;
  /** 参数元信息 */
  meta: GameParamMeta[];
}

/**
 * 各游戏的参数规格登记处。
 *
 * 游戏之间互不耦合：每个游戏一行注册，加新游戏不影响已有游戏。
 */
export const GAME_PARAM_SPECS: Record<string, GameParamSpec> = {
  snake: {
    resolver: resolveSnakeParams,
    defaults: DEFAULT_SNAKE_PARAMS,
    meta: SNAKE_PARAM_META.map(m => ({
      key: m.key,
      label: m.label,
      group: m.group,
      step: m.step,
      unit: m.unit,
      desc: m.desc,
      min: SNAKE_PARAM_RANGES[m.key].min,
      max: SNAKE_PARAM_RANGES[m.key].max,
      default: DEFAULT_SNAKE_PARAMS[m.key],
    })),
  },
};

/** 该游戏是否登记了可配置参数 */
export function hasGameParams(slug: string): boolean {
  return Boolean(GAME_PARAM_SPECS[slug]);
}

/**
 * 某个游戏的代码默认值（管理端显示「默认值 / 当前值」对照用）。
 */
export function getGameDefaultParams(slug: string): Record<string, number> {
  return GAME_PARAM_SPECS[slug]?.defaults || {};
}

/**
 * 校验并规范化一份待保存的参数配置（管理端写入用）。
 *
 * 存的是**解析后的完整值**，不是运营输入的原始片段：
 * - 数据库自解释，任何时候都能看出这个游戏实际生效的数值；
 * - 以后代码改默认值，不会悄悄改掉运营已经调过的游戏。
 */
export function normalizeGameParams(slug: string, raw: unknown): Record<string, number> {
  const spec = GAME_PARAM_SPECS[slug];
  if (!spec) throw new Error('该游戏暂无可配置参数');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数配置格式不对');
  return spec.resolver(raw);
}

/** 参数是否与代码默认值完全一致（管理端显示「默认 / 已自定义」标记） */
export function isGameParamsDefault(slug: string, raw: unknown): boolean {
  const defaults = getGameDefaultParams(slug);
  if (!Object.keys(defaults).length) return true;
  const resolved = normalizeGameParams(slug, raw ?? {});
  return Object.keys(defaults).every(k => resolved[k] === defaults[k]);
}

export type { SnakeParams };
