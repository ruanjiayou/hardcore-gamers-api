/**
 * 团队房合局策略（纯函数，无 IO，便于单测）。
 *
 * GM-snake-36 / SB-064：团队房 = 5 人 1 队（固定房主），3 个就绪队房凑齐合成 1 局。
 * 队伍在**合局时**按房间顺序分配（红/蓝/黄），进房阶段成员不带 team。
 */

import type { IMember, IRoom } from '../types';
import { SNAKE_TEAM_NAMES } from '../games/snake/teams';

/** 一局需要的队房数量 */
export const TEAM_MATCH_ROOMS = 3;

export interface TeamReadyState {
  /** 当前就绪池中的房间 id（有序，先点开始的在前） */
  roomIds: string[];
  /** 还差几房开局 */
  need: number;
  /** 是否已凑齐，可以合局 */
  full: boolean;
}

/** 把房间加入就绪池；重复点击幂等；满池后新房不再进入。 */
export function joinTeamPool(pool: string[], roomId: string, need = TEAM_MATCH_ROOMS): TeamReadyState {
  const current = pool.slice(0, need);
  if (!current.includes(roomId) && current.length < need) current.push(roomId);
  return { roomIds: current, need: Math.max(0, need - current.length), full: current.length >= need };
}

/** 房间解散/离开时从就绪池移除。 */
export function removeFromTeamPool(pool: string[], roomId: string): string[] {
  return pool.filter(id => id !== roomId);
}

export interface MergedTeamPlayers {
  /** 参与合局的房间 id（最多 3 个，顺序即队伍顺序） */
  roomIds: string[];
  /** 全部成员，team 按房间顺序覆盖写入 */
  players: IMember[];
}

/**
 * 按房间给成员分队：第 i 个房间的全体成员 = 第 i 支队伍。
 * 成员自带的 team 一律覆盖（进房阶段不再分队，旧数据也不作数）。
 */
export function assignTeamsByRoom(rooms: IRoom[], names: string[] = SNAKE_TEAM_NAMES): MergedTeamPlayers {
  const chosen = rooms.slice(0, names.length);
  const players: IMember[] = [];
  chosen.forEach((room, i) => {
    const team = names[i];
    for (const m of (room.members || [])) {
      players.push({ ...m, team } as IMember);
    }
  });
  return { roomIds: chosen.map(r => r._id), players };
}
