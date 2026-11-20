import type { IGame } from '../types';

/**
 * 旧数据兼容：games 集合中早于 mode 字段写入的记录没有 mode（lean 读取不套 schema 默认值），
 * 按人数兜底推断（1 人 = solo），保证服务端校验与前端主页形态口径一致。
 *
 * 纯函数，无数据库副作用，便于单测（见 test/game-mode.test.ts）。
 */
export function normalizeMode<T extends { mode?: IGame['mode'], numbers?: { min: number, max: number } }>(game: T): T {
  if (!game.mode) {
    game.mode = (game.numbers?.max ?? 2) <= 1 ? 'solo' : 'room';
  }
  return game;
}

/** 游戏是否单人模式（走快开、无房间 UI）。缺 mode 时按人数兜底。 */
export function isSoloGame(game: { mode?: IGame['mode'], numbers?: { min: number, max: number } }): boolean {
  return normalizeMode(game).mode === 'solo';
}
