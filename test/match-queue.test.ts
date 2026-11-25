/**
 * 常驻竞技场等待队列（SB-059）。
 *
 * 语义：竞技场的桌子是**预建的官方桌**，匹配不新建房间 ——
 * 有空位就进，没空位就排队；有人离开腾出位置，排队的人被拉进去。
 */
import { describe, test, expect } from 'bun:test';
import { MatchQueue, matchQueueKey, type MatchWaiter } from '../src/services/MatchQueueService';

const waiter = (player_id: string, over: Partial<MatchWaiter> = {}): MatchWaiter => ({
  player_id,
  game_id: 'snake',
  variant: 'endless',
  nickname: player_id,
  socket_id: `sock-${player_id}`,
  enqueued_at: Date.now(),
  ...over,
});

describe('匹配等待队列', () => {
  test('队列 key = game_id + variant（不同玩法各排各的）', () => {
    expect(matchQueueKey('snake', 'endless')).toBe('snake::endless');
    expect(matchQueueKey('snake', 'team')).toBe('snake::team');
    expect(matchQueueKey('chess', '')).toBe('chess::');
  });

  test('入队后能查到人，重复入队不产生第二条', () => {
    const q = new MatchQueue();
    q.enqueue(waiter('p1'));
    expect(q.size('snake', 'endless')).toBe(1);
    q.enqueue(waiter('p1'));
    expect(q.size('snake', 'endless')).toBe(1);
    expect(q.peek('p1')?.player_id).toBe('p1');
  });

  test('取消排队：能移除，且只移除自己那一条', () => {
    const q = new MatchQueue();
    q.enqueue(waiter('p1'));
    q.enqueue(waiter('p2'));
    expect(q.cancel('p1')).toBe(true);
    expect(q.cancel('p1')).toBe(false);
    expect(q.size('snake', 'endless')).toBe(1);
    expect(q.peek('p2')?.player_id).toBe('p2');
  });

  test('断线清理：按 socket 摘掉排队记录', () => {
    const q = new MatchQueue();
    q.enqueue(waiter('p1'));
    expect(q.cancelBySocket('sock-p1')).toBe(true);
    expect(q.cancelBySocket('sock-p1')).toBe(false);
    expect(q.size()).toBe(0);
  });

  test('取出按 FIFO：最早排队的先进桌', () => {
    const q = new MatchQueue();
    q.enqueue(waiter('p1', { enqueued_at: 100 }));
    q.enqueue(waiter('p2', { enqueued_at: 200 }));
    expect(q.take('snake', 'endless')?.player_id).toBe('p1');
    expect(q.take('snake', 'endless')?.player_id).toBe('p2');
    expect(q.take('snake', 'endless')).toBeNull();
  });

  test('不同玩法互不串队', () => {
    const q = new MatchQueue();
    q.enqueue(waiter('p1', { variant: 'endless' }));
    q.enqueue(waiter('p2', { variant: 'team' }));
    expect(q.take('snake', 'team')?.player_id).toBe('p2');
    expect(q.size('snake', 'endless')).toBe(1);
  });

  test('桌位释放 → 把等待者补进房间', async () => {
    const q = new MatchQueue();
    const entered: string[] = [];
    q.bindJoiner(async (w) => {
      entered.push(w.player_id);
      return true;
    });
    q.enqueue(waiter('p1'));
    q.enqueue(waiter('p2'));
    const filled = await q.fill({ _id: 'room-1', game_id: 'snake', settings: { variant: 'endless' } }, 1);
    expect(filled).toBe(1);
    expect(entered).toEqual(['p1']);
    expect(q.size()).toBe(1);
  });

  test('补位失败 → 放回队尾，不让这个人凭空消失', async () => {
    const q = new MatchQueue();
    q.bindJoiner(async () => false);
    q.enqueue(waiter('p1'));
    const filled = await q.fill({ _id: 'room-1', game_id: 'snake', settings: { variant: 'endless' } }, 1);
    expect(filled).toBe(0);
    expect(q.size()).toBe(1);
  });

  test('没有注入补位动作时不动作（不能崩）', async () => {
    const q = new MatchQueue();
    q.enqueue(waiter('p1'));
    expect(await q.fill({ _id: 'room-1', game_id: 'snake', settings: { variant: 'endless' } }, 1)).toBe(0);
  });

  test('队列只影响对应玩法的补位', async () => {
    const q = new MatchQueue();
    const entered: string[] = [];
    q.bindJoiner(async (w) => {
      entered.push(w.player_id);
      return true;
    });
    q.enqueue(waiter('p1', { variant: 'endless' }));
    q.enqueue(waiter('p2', { variant: 'team' }));
    await q.fill({ _id: 'room-1', game_id: 'snake', settings: { variant: 'team' } }, 1);
    expect(entered).toEqual(['p2']);
  });
});
