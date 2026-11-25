/**
 * 游戏可调参数（手感配置）服务 —— **读配置**这一层。
 *
 * 目的：**改一次配置就够，客户端不用改代码**。
 * 原来贪吃蛇的速度常量在服务端（rules.ts）与客户端（lobby Logic.ts）各写一份，
 * 运营想调个速度要改两处代码、还得保证两端数值完全一致 ——
 * 漏一处就会出现「蛇拉丝」（客户端预测与服务端权威值漂移）。
 *
 * 现在的链路：
 * 1. **代码默认值**：各游戏自己的 `params.ts`（如 `games/snake/params.ts`）；
 * 2. **数据库覆盖**：运营在管理端改 `games.config`（按游戏 slug 存）；
 * 3. **建局时冻结**：服务端读配置 → 解析 → 写进对局状态 → 随快照下发；
 * 4. **客户端读取**：客户端用服务端下发的同一份参数做本地预测。
 *
 * 关键约束：**参数在建局那一刻冻结**，整局不变。
 * 中途改数据库不会让同一局前后半段手感突变，客户端也不会突然算出不一样的速度。
 *
 * 参数规格表（字段清单 / 区间 / 默认值）在 `games/paramsRegistry.ts` —— 纯静态、可单测。
 */
import { MGame } from '../models';
import { resolveSnakeParams, type SnakeParams } from '../games/snake/params';
import { GAME_PARAM_SPECS, type GameParamMeta } from '../games/paramsRegistry';

export type { GameParamMeta } from '../games/paramsRegistry';

/** 管理端参数表单用的参数描述（含当前生效值） */
export interface GameParamField extends GameParamMeta {
  /** 当前生效值（数据库配置解析后的结果；没配置时等于默认值） */
  current: number;
}

/**
 * 读某个游戏的生效参数。
 *
 * @param slug 游戏 slug（如 `snake`）
 * @returns 解析后的参数；该游戏没有可调参数时返回空对象
 */
export async function getGameParams(slug: string): Promise<Record<string, number>> {
  const spec = GAME_PARAM_SPECS[slug];
  if (!spec) return {};
  try {
    const game = await MGame.findOne({ slug }, { config: 1 }).lean(true) as any;
    return spec.resolver(game?.config);
  } catch (error) {
    // 读库失败不能拖垮开局：退回代码默认值
    console.error(`❌ 读取游戏 ${slug} 的参数配置失败，改用代码默认值:`, error);
    return spec.resolver(undefined);
  }
}

/** 贪吃蛇的生效参数（类型化版本） */
export async function getSnakeParams(): Promise<SnakeParams> {
  const params = await getGameParams('snake');
  return resolveSnakeParams(params);
}

/**
 * 管理端参数表单的完整描述：元信息 + 当前生效值。
 *
 * 没登记参数的游戏返回 null（前端就不渲染这一段）。
 */
export async function getGameParamSchema(slug: string): Promise<GameParamField[] | null> {
  const spec = GAME_PARAM_SPECS[slug];
  if (!spec) return null;
  const current = await getGameParams(slug);
  return spec.meta.map(m => ({ ...m, current: current[m.key] ?? m.default }));
}
