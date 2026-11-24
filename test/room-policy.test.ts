import { describe, test, expect } from 'bun:test';
import {
  canSpectate,
  canDisbandRoom,
  canStartGame,
  canUpdateSettings,
  canKickMember,
  canTransferOwner,
  hasHumanOwner,
  normalizeOwner,
  pickTempOwner,
  resolveLeaveAction,
  shouldTakeOwnership,
} from '../src/utils/roomPolicy';

const human = (id: string, member_type = 'player') => ({ _id: id, member_type, player_type: 'player' });
const robot = (id: string, member_type = 'player') => ({ _id: id, member_type, player_type: 'robot' });

describe('房主归属（SB-039：私有房主 vs 官方临时房主）', () => {
  test('官方临时房主 = 房内第一位真人对战玩家，跳过人机与观战者', () => {
    expect(pickTempOwner([robot('r1'), human('v1', 'viewer'), human('p2'), human('p3')])).toBe('p2');
    expect(pickTempOwner([robot('r1')])).toBe('');
    expect(pickTempOwner([])).toBe('');
  });

  test('人机永远不能成为房主：进房不接任', () => {
    // 空官方桌：人机进来不写 owner_id
    expect(shouldTakeOwnership({ official: true, members: [] }, robot('r1'))).toBe(false);
    // 空私有房：人机同样不接
    expect(shouldTakeOwnership({ official: false, members: [] }, robot('r1'))).toBe(false);
    // 观战者也不接
    expect(shouldTakeOwnership({ official: true, members: [] }, human('v1', 'viewer'))).toBe(false);
  });

  test('官方空桌由第一位真人接任；已有真人房主时下一位真人不再夺权', () => {
    const empty = { official: true, members: [] as any[] };
    expect(shouldTakeOwnership(empty, human('p1'))).toBe(true);
    const owned = { official: true, owner_id: 'p1', members: [human('p1'), robot('r1')] };
    expect(shouldTakeOwnership(owned, human('p2'))).toBe(false);
  });

  test('官方桌历史脏数据（人机房主）：下一位真人接任', () => {
    const room = { official: true, owner_id: 'r1', members: [robot('r1')] };
    expect(hasHumanOwner(room)).toBe(false);
    expect(shouldTakeOwnership(room, human('p1'))).toBe(true);
  });

  test('normalizeOwner：人机房主 / 悬空房主都要校正，合法房主返回 null', () => {
    // 人机房主 + 房里有真人 → 交给第一位真人
    expect(normalizeOwner({
      official: true,
      owner_id: 'r1',
      members: [robot('r1'), human('p2'), human('p3')],
    })).toBe('p2');
    // 人机房主 + 房里没真人 → 置空
    expect(normalizeOwner({ official: true, owner_id: 'r1', members: [robot('r1')] })).toBe('');
    // 房主已不在成员表（悬空）→ 交给第一位真人
    expect(normalizeOwner({ official: true, owner_id: 'gone', members: [human('p2')] })).toBe('p2');
    // 正常：不动
    expect(normalizeOwner({ official: true, owner_id: 'p1', members: [human('p1')] })).toBeNull();
    // 空房主：不动
    expect(normalizeOwner({ official: true, owner_id: '', members: [] })).toBeNull();
  });
});

describe('踢人权限', () => {
  const privateRoom = { official: false, owner_id: 'p1', members: [human('p1'), human('p2'), robot('r1')] };
  const officialRoom = { official: true, owner_id: 'p1', members: [human('p1'), robot('r1')] };

  test('私有房主不能被踢（管理端也不行），其余成员可以', () => {
    expect(canKickMember(privateRoom, 'p1').ok).toBe(false);
    expect(canKickMember(privateRoom, 'p1').reason).toContain('私有房主');
    expect(canKickMember(privateRoom, 'p2').ok).toBe(true);
    expect(canKickMember(privateRoom, 'r1').ok).toBe(true);
  });

  test('官方房临时房主可被踢（这正是管理端踢不掉人机房主的根因）', () => {
    expect(canKickMember(officialRoom, 'p1').ok).toBe(true);
    expect(canKickMember(officialRoom, 'r1').ok).toBe(true);
  });

  test('房间内踢人必须是房主；管理端（不传 by）豁免身份但保留业务约束', () => {
    expect(canKickMember(privateRoom, 'p2', 'p2').ok).toBe(false);
    expect(canKickMember(privateRoom, 'p2', 'p2').reason).toContain('房主');
    expect(canKickMember(privateRoom, 'p2', 'p1').ok).toBe(true);
    // 官方房：临时房主可踢人
    expect(canKickMember(officialRoom, 'r1', 'p1').ok).toBe(true);
    // 不存在的人
    expect(canKickMember(officialRoom, 'nobody').ok).toBe(false);
  });
});

describe('转让房主权限', () => {
  const privateRoom = { official: false, owner_id: 'p1', members: [human('p1'), human('p2'), robot('r1'), human('v1', 'viewer')] };

  test('私有房主可以转让给房内的非人机对战玩家', () => {
    expect(canTransferOwner(privateRoom, 'p2', 'p1').ok).toBe(true);
    expect(canTransferOwner(privateRoom, 'p2').ok).toBe(true);
  });

  test('不能转给人机、观战者或房外的人（否则房间没人能开局）', () => {
    expect(canTransferOwner(privateRoom, 'r1', 'p1').reason).toContain('人机');
    expect(canTransferOwner(privateRoom, 'v1', 'p1').reason).toContain('观战');
    expect(canTransferOwner(privateRoom, 'nobody', 'p1').reason).toContain('不在房间');
  });

  test('只有现房主能转让', () => {
    expect(canTransferOwner(privateRoom, 'r1', 'p2').ok).toBe(false);
    expect(canTransferOwner(privateRoom, 'p2', 'p2').reason).toContain('只有房主');
  });

  test('官方房只有临时房主，不存在转让', () => {
    const room = { official: true, owner_id: 'p1', members: [human('p1'), human('p2')] };
    expect(canTransferOwner(room, 'p2', 'p1').reason).toContain('临时房主');
  });
});

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

  test('自建房房主离开：自动转让给非人机玩家', () => {
    const room = {
      owner_id: 'p1',
      members: [human('p1'), robot('r1'), human('p2'), human('p3', 'viewer')],
    };
    const d = resolveLeaveAction(room, 'p1');
    expect(d.action).toBe('leave');
    if (d.action === 'leave') {
      // 跳过人机与观战者，转让给真人对战玩家 p2
      expect(d.transferOwnerTo).toBe('p2');
      expect(d.reset).toBe(false);
    }
  });

  test('自建房房主离开且只剩人机：解散房间（人机自动离开）', () => {
    const room = {
      owner_id: 'p1',
      members: [human('p1'), robot('r1'), robot('r2')],
    };
    expect(resolveLeaveAction(room, 'p1')).toEqual({ action: 'destroy' });
  });

  test('自建房房主离开但只剩观战者：解散房间', () => {
    const room = {
      owner_id: 'p1',
      members: [human('p1'), human('v1', 'viewer'), robot('r1')],
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

  test('官方无尽房：真人离开不清场、不回收人机（人机常驻陪玩）', () => {
    const room = {
      official: true,
      variant: 'endless',
      owner_id: 'p1',
      members: [human('p1'), robot('r1'), robot('r2')],
    };
    const d = resolveLeaveAction(room, 'p1');
    expect(d.action).toBe('leave');
    if (d.action === 'leave') {
      // 不 reset：人机留在房里，对局继续
      expect(d.reset).toBe(false);
      expect(d.transferOwnerTo).toBe('');
    }
  });

  test('官方无尽房：真人离开时房主转让给下一位真人对战玩家', () => {
    const room = {
      official: true,
      variant: 'endless',
      owner_id: 'p1',
      members: [human('p1'), robot('r1'), human('p2')],
    };
    const d = resolveLeaveAction(room, 'p1');
    expect(d.action).toBe('leave');
    if (d.action === 'leave') {
      expect(d.transferOwnerTo).toBe('p2');
      expect(d.reset).toBe(false);
    }
  });
});
