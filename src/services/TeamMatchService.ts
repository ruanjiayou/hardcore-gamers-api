/**
 * 团队房合局编排（SB-064 / GM-snake-36）。
 *
 * 流程：房主点「开始游戏」→ markReady(room) 把队房放入按 game_id 分组的就绪池
 * → 池子凑齐 3 房 → 调 roomService.startTeamMatch(三房并集建 1 局、按房间分队)
 * → 向三个 room 频道各发一次 room:game-start（同一个 match_id）→ spawn 运行时。
 *
 * 不足 3 房时不建局，只广播 room:team-match-status 让前端显示「等待其他队伍」。
 * 依赖以构造参数注入（IO / 建局 / 运行时均可用假对象单测）。
 */

import type { Server } from 'socket.io';
import type { IRoom } from '../types';
import { joinTeamPool, removeFromTeamPool, TEAM_MATCH_ROOMS } from './teamMatchPolicy';

export interface TeamMatchReadyResult {
  /** 空串 = 尚未凑齐；非空 = 合局已建的对局 id */
  match_id: string;
  room_ids: string[];
  ready_rooms: number;
  need: number;
}

/** 只取用得到的接口，避免把具体 class 拖进本模块 */
interface TeamMatchDeps {
  startTeamMatch(rooms: IRoom[]): Promise<string>;
}

interface RuntimeDeps {
  spawn(match: any): void;
}

interface MatchProvider {
  findById(id: string): Promise<any>;
}

export class TeamMatchService {
  private pools = new Map<string, string[]>();
  private io: Server | null = null;

  constructor(
    private readonly rooms: TeamMatchDeps,
    private readonly runtime: RuntimeDeps,
    private readonly matches: MatchProvider,
  ) {}

  setIO(io: Server) {
    this.io = io;
  }

  /** 当前就绪房数（单测/调试用） */
  readyCount(game_id: string) {
    return (this.pools.get(game_id) || []).length;
  }

  /** 查询就绪池快照 */
  readyRooms(game_id: string): string[] {
    return [...(this.pools.get(game_id) || [])];
  }

  /** 房间离开/解散/被踢导致不可用：从就绪池移除并广播新状态 */
  cancel(game_id: string, room_id: string) {
    const next = removeFromTeamPool(this.pools.get(game_id) || [], room_id);
    this.pools.set(game_id, next);
    this.broadcastStatus(game_id, next);
  }

  /**
   * 房主点开始：加入就绪池；满 3 房则合局开局。
   */
  async markReady(room: IRoom): Promise<TeamMatchReadyResult> {
    const gameId = String(room.game_id || '');
    const state = joinTeamPool(this.pools.get(gameId) || [], room._id);
    this.pools.set(gameId, state.roomIds);

    if (!state.full) {
      this.broadcastStatus(gameId, state.roomIds);
      return { match_id: '', room_ids: state.roomIds, ready_rooms: state.roomIds.length, need: state.need };
    }

    // 凑齐 3 房：本轮池子消费掉，后续房主要重新点开始
    this.pools.set(gameId, []);
    const roomIds = state.roomIds;

    // 建局：三房成员并集 + 按房间顺序分队（roomService 内部按 _id 查库）
    const match_id = await this.rooms.startTeamMatch(roomIds.map(id => ({ _id: id }) as IRoom));
    if (match_id) {
      const started = await this.matches.findById(match_id);
      const now = Date.now();
      for (const id of roomIds) {
        this.io?.to(`room:${id}`).emit('room:game-start', { room_id: id, match_id, timestamp: now });
      }
      if (started && started.curr_state?.timeControl?.enabled) {
        // 团队合局暂不开计时（队伍人数与房间分离，时钟语义待定）；保留接口占位
      }
      if (started) this.runtime.spawn(started);
    }

    return {
      match_id,
      room_ids: roomIds,
      ready_rooms: roomIds.length,
      need: Math.max(0, TEAM_MATCH_ROOMS - roomIds.length),
    };
  }

  private broadcastStatus(gameId: string, roomIds: string[]) {
    const need = Math.max(0, TEAM_MATCH_ROOMS - roomIds.length);
    for (const id of roomIds) {
      this.io?.to(`room:${id}`).emit('room:team-match-status', {
        room_id: id,
        ready_rooms: roomIds.length,
        need,
      });
    }
  }
}

/** 由 index.ts 启动时注入具体实现（延迟绑定，避免循环 import） */
export const roomServiceProxy: TeamMatchDeps = { startTeamMatch: async () => '' };
export const snakeRuntimeProxy: RuntimeDeps = { spawn: () => {} };
export const matchModelProxy: MatchProvider = { findById: async () => null };

export const teamMatchService = new TeamMatchService(
  { startTeamMatch: (rooms: IRoom[]) => roomServiceProxy.startTeamMatch(rooms) },
  { spawn: (match: any) => snakeRuntimeProxy.spawn(match) },
  { findById: (id: string) => matchModelProxy.findById(id).lean(true) },
);
