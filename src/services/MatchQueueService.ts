/**
 * 常驻竞技场等待队列。
 *
 * 竞技场（arena 玩法）的桌子是**预建的官方桌**，玩家匹配时只有两种结果：
 * - 桌上有空位 → 直接进桌；
 * - 所有桌都满员 → 进队列等着，等有人离开腾出位置再被拉进去。
 *
 * 关键约束：**匹配永远不新建房间**。建桌是管理后台的职责（POST /api/admin/rooms），
 * 客户端点「开始无尽挑战」只会「进已有桌 / 排队」。
 *
 * 队列是**进程内**的：同一房间同一时刻只允许一个运行时（SB-053），
 * 服务端本来也是单进程权威，队列跟着进程走即可；进程重启后队列清空，
 * 玩家重新点一次匹配即可（不会丢进度，只是重新排）。
 *
 * 这个类不碰数据库也不碰 socket —— 「把等待者塞进房间」由外部注入的
 * joiner 负责（见 index.ts 的 bindJoiner），避免这里反向依赖 RoomService 造成循环引用。
 */

export interface MatchWaiter {
  /** 玩家 id（MPlayer._id） */
  player_id: string;
  /** 游戏 id（MGame._id） */
  game_id: string;
  /** 玩法变体 key（贪吃蛇：endless）；空串表示无变体 */
  variant: string;
  nickname: string;
  skin?: string;
  /** 当前 socket id：分配到桌后要靠它把玩家带进房间 */
  socket_id: string;
  /** 入队时间戳（FIFO） */
  enqueued_at: number;
}

/** 队列的目标房间（只需要够 joiner 用的最小信息） */
export interface MatchTargetRoom {
  _id: string;
  game_id: string;
  settings?: { variant?: string; arena?: boolean };
}

/** 进桌动作：返回 true 表示已经把人放进房间了 */
export type MatchJoiner = (waiter: MatchWaiter, room: MatchTargetRoom) => Promise<boolean>;

/** 同一个玩法变体共用一条队列：key = game_id + variant */
export function matchQueueKey(game_id: string, variant: string): string {
  return `${game_id}::${variant || ''}`;
}

export class MatchQueue {
  private waiters: MatchWaiter[] = [];
  private joiner: MatchJoiner | null = null;

  /** 注入「把等待者放进房间」的动作（启动时由 index.ts 注册） */
  bindJoiner(joiner: MatchJoiner): void {
    this.joiner = joiner;
  }

  /**
   * 入队。同一玩家只排一次（换玩法 / 重复点匹配时先挤掉旧位置）。
   */
  enqueue(waiter: MatchWaiter): MatchWaiter {
    this.cancel(waiter.player_id);
    this.waiters.push(waiter);
    return waiter;
  }

  /** 取消排队（玩家主动取消 / 断线）。返回是否真的移除了 */
  cancel(player_id: string): boolean {
    const index = this.waiters.findIndex(w => w.player_id === player_id);
    if (index === -1) return false;
    this.waiters.splice(index, 1);
    return true;
  }

  /** 查询某个玩家是否在排队 */
  peek(player_id: string): MatchWaiter | undefined {
    return this.waiters.find(w => w.player_id === player_id);
  }

  /** 按 socket 清掉排队记录（断线时用） */
  cancelBySocket(socket_id: string): boolean {
    const index = this.waiters.findIndex(w => w.socket_id === socket_id);
    if (index === -1) return false;
    this.waiters.splice(index, 1);
    return true;
  }

  /** 队列快照（可按玩法过滤） */
  list(game_id?: string, variant?: string): MatchWaiter[] {
    return this.waiters.filter(w =>
      (game_id ? w.game_id === game_id : true) &&
      (variant !== undefined ? w.variant === variant : true)
    );
  }

  /** 该玩法当前排队人数 */
  size(game_id?: string, variant?: string): number {
    return this.list(game_id, variant).length;
  }

  /**
   * 取出该玩法最早排队的一个人（并从队列移除）。
   * 没有则返回 null。
   */
  take(game_id: string, variant: string): MatchWaiter | null {
    const index = this.waiters.findIndex(w =>
      w.game_id === game_id && w.variant === (variant || '')
    );
    if (index === -1) return null;
    return this.waiters.splice(index, 1)[0];
  }

  /**
   * 桌位释放后把等待者补进来。
   *
   * @param room 腾出位置的桌子
   * @param seats 本次空出的座位数（默认 1）
   * @returns 实际补进去的人数
   */
  async fill(room: MatchTargetRoom, seats = 1): Promise<number> {
    if (!this.joiner) return 0;
    const variant = room.settings?.variant || '';
    let filled = 0;
    while (filled < seats) {
      const waiter = this.take(room.game_id, variant);
      if (!waiter) break;
      let ok = false;
      try {
        ok = await this.joiner(waiter, room);
      } catch (error) {
        console.log('❌ 匹配补位失败:', error);
      }
      if (!ok) {
        // 进桌失败（房间被别人抢先占满等）→ 放回队尾，别让这个人凭空消失
        this.waiters.push({ ...waiter, enqueued_at: Date.now() });
        break;
      }
      filled++;
    }
    return filled;
  }

  /** 清空（测试用 / 服务重置） */
  clear(): void {
    this.waiters = [];
  }
}

/** 全局单例 */
export const matchQueue = new MatchQueue();
