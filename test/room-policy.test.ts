import { describe, test, expect } from 'bun:test';
import {
  canSpectate,
  canDisbandRoom,
  canStartGame,
  canUpdateSettings,
  resolveLeaveAction,
} from '../src/utils/roomPolicy';

const human = (id: string, member_type = 'player') => ({ _id: id, member_type, player_type: 'player' });
const robot = (id: string, member_type = 'player') => ({ _id: id, member_type, player_type: 'robot' });

describe('观战开关', () => {
  test('默认允许观战，显式 false 才禁止', () => {
    expect(canSpectate({})).toBe(true);
    expect(canSpectate({ allowSpectate: true })).toBe(true);
    expect(canSpectate({ allowSpectate: false })).toBe(false);
  });
});

describe('解散权限', () => {
  test('官方房任何人（含房主）都不能解散', () => {
    const room = { official: true, owner_id: 'p1', members: [human('p1')] };
    expect(canDisbandRoom(room, 'p1').ok).toBe(false);
    expect(canDisbandRoom(room, 'p2').ok).toBe(false);
    expect(canDisbandRoom(room, 'p1').reason).toContain('官方');
  });

  test('自建房仅房主可解散', () => {
    const room = { official: false, owner_id: 'p1', members: [human('p1'), human('p2')] };
    expect(canDisbandRoom(room, 'p1').ok).toBe(true);
    expect(canDisbandRoom(room, 'p2').ok).toBe(false);
    expect(canDisbandRoom(room, 'p2').reason).toContain('房主');
  });

  test('临时房（单人快开）房主可销毁，无身份拒绝', () => {
    const room = { transient: true, owner_id: 'p1', members: [human('p1')] };
    expect(canDisbandRoom(room, 'p1').ok).toBe(true);
    expect(canDisbandRoom(room, '').ok).toBe(false);
  });
});

describe('开局权限', () => {
  test('仅房间内对战玩家、房主、等待态可开局', () => {
    const room = {
      status: 'waiting',
      owner_id: 'p1',
      members: [human('p1'), human('p2'), human('p3', 'viewer')],
    };
    expect(canStartGame(room, 'p1').ok).toBe(true);
    // 非房主的对战玩家不能开局
    expect(canStartGame(room, 'p2').ok).toBe(false);
    // 观战者不能开局
    expect(canStartGame(room, 'p3').ok).toBe(false);
    // 非成员不能开局
    expect(canStartGame(room, 'p9').ok).toBe(false);
  });

  test('对局进行中不能开局', () => {
    const room = { status: 'playing', owner_id: 'p1', members: [human('p1')] };
    expect(canStartGame(room, 'p1').ok).toBe(false);
  });

  test('官方房：第一位入座玩家是房主，可开局', () => {
    const room = { official: true, status: 'waiting', owner_id: 'p1', members: [human('p1'), human('p2')] };
    expect(canStartGame(room, 'p1').ok).toBe(true);
    expect(canStartGame(room, 'p2').ok).toBe(false);
  });
});

describe('房间设置权限', () => {
  test('仅房主可改设置（含观战开关）', () => {
    const room = { owner_id: 'p1', members: [human('p1'), human('p2')] };
    expect(canUpdateSettings(room, 'p1').ok).toBe(true);
    expect(canUpdateSettings(room, 'p2').ok).toBe(false);
  });
});

describe('离开房间流转', () => {
  test('临时房随时可离开（含游戏中），离开即销毁', () => {
    const room = {
      transient: true,
      status: 'playing',
      owner_id: 'p1',
      members: [human('p1')],
    };
    expect(resolveLeaveAction(room, 'p1')).toEqual({ action: 'destroy' });
  });

  test('普通房间游戏中禁止离开', () => {
    const room = {
      status: 'playing',
      owner_id: 'p1',
      members: [human('p1'), human('p2')],
    };
    const d = resolveLeaveAction(room, 'p2');
    expect(d.action).toBe('blocked');
  });

  test('不在房间内的人不能离开', () => {
    const room = { owner_id: 'p1', members: [human('p1')] };
    expect(resolveLeaveAction(room, 'p9').action).toBe('blocked');
  });

  test('自建房房主离开即解散', () => {
    const room = {
      owner_id: 'p1',
      members: [human('p1'), human('p2'), robot('r1')],
    };
    expect(resolveLeaveAction(room, 'p1')).toEqual({ action: 'destroy' });
  });

  test('自建房普通成员离开仅退出；还有真人时不回收机器人', () => {
    const room = {
      owner_id: 'p1',
      members: [human('p1'), human('p2'), robot('r1')],
    };
    const d = resolveLeaveAction(room, 'p2');
    expect(d.action).toBe('leave');
    if (d.action === 'leave') {
      expect(d.reset).toBe(false);
      expect(d.transferOwnerTo).toBeUndefined();
    }
  });

  test('自建房最后一位真人离开时回收机器人（reset）', () => {
    // p1 是房主但已不在成员中（历史数据边缘），p2 离开后只剩机器人
    const room = {
      owner_id: 'p1',
      members: [human('p2'), robot('r1')],
    };
    const d = resolveLeaveAction(room, 'p2');
    expect(d.action).toBe('leave');
    if (d.action === 'leave') expect(d.reset).toBe(true);
  });

  test('官方房成员离开只退出，不解散、房主不变', () => {
    const room = {
      official: true,
      owner_id: 'p1',
      members: [human('p1'), human('p2')],
    };
    const d = resolveLeaveAction(room, 'p2');
    expect(d.action).toBe('leave');
    if (d.action === 'leave') {
      expect(d.transferOwnerTo).toBeUndefined();
      expect(d.reset).toBe(false);
    }
  });

  test('官方房房主离开：房主转让给下一位真人对战玩家', () => {
    const room = {
      official: true,
      owner_id: 'p1',
      members: [human('p1'), robot('r1'), human('p2'), human('p3', 'viewer')],
    };
    const d = resolveLeaveAction(room, 'p1');
    expect(d.action).toBe('leave');
    if (d.action === 'leave') {
      // 转让给 p2（真人对战玩家），跳过机器人与观战者
      expect(d.transferOwnerTo).toBe('p2');
      expect(d.reset).toBe(false);
    }
  });

  test('官方房最后一位真人离开：空桌重置（清成员、房主置空）', () => {
    const room = {
      official: true,
      owner_id: 'p1',
      members: [human('p1'), robot('r1')],
    };
    const d = resolveLeaveAction(room, 'p1');
    expect(d.action).toBe('leave');
    if (d.action === 'leave') {
      expect(d.reset).toBe(true);
      expect(d.transferOwnerTo).toBe('');
    }
  });

  test('官方房观战者离开：只退出，不影响房主', () => {
    const room = {
      official: true,
      owner_id: 'p1',
      members: [human('p1'), human('v1', 'viewer')],
    };
    const d = resolveLeaveAction(room, 'v1');
    expect(d.action).toBe('leave');
    if (d.action === 'leave') {
      expect(d.transferOwnerTo).toBeUndefined();
      expect(d.reset).toBe(false);
    }
  });
});
