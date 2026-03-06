/**
 * 玩家匹配服务
 * 负责实时匹配算法
 */

import type { MatchingRequest } from '../types/index';

export class MatchingService {
  private matchingQueues: Map<string, MatchingRequest[]> = new Map();

  /**
   * 添加到匹配队列
   */
  addToQueue(request: MatchingRequest): void {
    if (!this.matchingQueues.has(request.game_id)) {
      this.matchingQueues.set(request.game_id, []);
    }

    this.matchingQueues.get(request.game_id)!.push(request);
    console.log(`📍 玩家 ${request.player_id} 加入匹配队列 (游戏: ${request.game_id})`);
  }

  /**
   * 从匹配队列移除
   */
  removeFromQueue(game_name: string, player_id: string): void {
    const queue = this.matchingQueues.get(game_name);
    if (queue) {
      const index = queue.findIndex(r => r.player_id === player_id);
      if (index !== -1) {
        queue.splice(index, 1);
        console.log(`🚫 玩家 ${player_id} 取消匹配 (游戏: ${game_name})`);
      }
    }
  }

  /**
   * 执行匹配算法
   * 简单版本：找出匹配条件相近的玩家
   */
  findMatch(game_name: string, minGroupSize: number = 2, maxWaitTime: number = 30000): MatchingRequest[] | null {
    const queue = this.matchingQueues.get(game_name);
    if (!queue || queue.length < minGroupSize) {
      return null;
    }

    // 按匹配时间排序（最早的优先）
    queue.sort((a, b) => a.createdAt - b.createdAt);

    // 找出最早的 minGroupSize 个请求
    const matched = queue.slice(0, minGroupSize);

    // 检查等待时间
    const now = Date.now();
    const maxWaitTimeExceeded = matched.some(req => now - req.createdAt > maxWaitTime);

    if (matched.length === minGroupSize || maxWaitTimeExceeded) {
      // 从队列中移除已匹配的
      this.matchingQueues.set(
        game_name,
        queue.filter(req => !matched.includes(req))
      );

      console.log(`✅ 匹配成功: ${matched.length} 个玩家 (游戏: ${game_name})`);
      return matched;
    }

    return null;
  }

  /**
   * 获取匹配队列信息
   */
  getQueueInfo(game_name: string): any {
    const queue = this.matchingQueues.get(game_name) || [];
    return {
      game_name,
      queueSize: queue.length,
      averageWaitTime: queue.length > 0
        ? Math.round(
          (Date.now() - queue[0].createdAt) / 1000
        )
        : 0
    };
  }

  /**
   * 获取所有匹配队列信息
   */
  getAllQueuesInfo(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [game_name, queue] of this.matchingQueues) {
      result[game_name] = this.getQueueInfo(game_name);
    }
    return result;
  }
}

export const matchingService = new MatchingService();