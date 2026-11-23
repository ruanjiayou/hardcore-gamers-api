/**
 * 房间权限与流转决策 - 纯函数，无 DB 依赖，便于单测。
 *
 * 固定房语义：
 * - 官方公共房（official）：任何人只能退出、不可解散；房主离开把房主转让给下一位真人玩家；
 *   没有真人时房间重置保留（空桌复用）。
 * - 自建房：仅房主（创建者/持有者）可解散；房主离开即解散。
 * - 单人快开房（transient）：不进房间列表，随时可离开，离开即销毁（分数已实时上报）。
 * - 观战：room.allowSpectate === false 时禁止以 viewer 身份进入。
 */
import constant from '../constant'

export interface PolicyMember {
  _id: string
  member_type: string
  player_type: string
}

export interface PolicyRoom {
  status?: string
  owner_id?: string
  official?: boolean
  transient?: boolean
  allowSpectate?: boolean
  members?: PolicyMember[]
  /** 玩法变体：endless（无尽挑战）是常驻对局，随时可以退出 */
  variant?: string
}

export interface Decision {
  ok: boolean
  reason?: string
}

/** 是否允许观战：默认允许，显式 false 才禁止 */
export function canSpectate(room: Pick<PolicyRoom, 'allowSpectate'>): boolean {
  return room.allowSpectate !== false
}

/** 能否解散房间：官方房永远不行；自建房仅房主 */
export function canDisbandRoom(room: PolicyRoom, requesterPlayerId: string): Decision {
  if (room.official) return { ok: false, reason: '官方房间不能解散，请退出房间' }
  if (!requesterPlayerId) return { ok: false, reason: '无法确认你的身份' }
  if (room.owner_id && room.owner_id !== requesterPlayerId) return { ok: false, reason: '只有房主可以解散房间' }
  return { ok: true }
}

/** 能否开始游戏：仅房间内对战玩家、房主、且房间在等待态 */
export function canStartGame(room: PolicyRoom, requesterPlayerId: string): Decision {
  const isMember = !!requesterPlayerId && (room.members || []).some(
    m => m._id === requesterPlayerId && m.member_type === constant.MEMBER.TYPE.player
  )
  if (!isMember) return { ok: false, reason: '只有房间内的对战玩家可以开始游戏' }
  if (room.status !== constant.ROOM.STATUS.waiting) return { ok: false, reason: '当前房间不能开始游戏' }
  if (room.owner_id && room.owner_id !== requesterPlayerId) return { ok: false, reason: '只有房主可以开始游戏' }
  return { ok: true }
}

/** 能否修改房间设置（含观战开关）：仅房主 */
export function canUpdateSettings(room: PolicyRoom, requesterPlayerId: string): Decision {
  if (!requesterPlayerId) return { ok: false, reason: '无法确认你的身份' }
  if (room.owner_id && room.owner_id !== requesterPlayerId) return { ok: false, reason: '只有房主可以修改房间设置' }
  return { ok: true }
}

export type LeaveDecision =
  | { action: 'blocked', reason: string }
  /** 离开并销毁房间（临时房 / 自建房房主离开） */
  | { action: 'destroy' }
  /** 仅退出该房间 */
  | {
    action: 'leave',
    /** 房主离开官方房时，转让给该玩家（'' 表示无下家，房主置空）；undefined 表示房主不变 */
    transferOwnerTo?: string
    /** 房间内已无真人：回收机器人、清空成员（官方房同时重置为空桌） */
    reset?: boolean
  }

/**
 * 离开房间的流转决策。
 * @param room 房间快照（含 members）
 * @param player_id 离开者
 */
export function resolveLeaveAction(room: PolicyRoom, player_id: string): LeaveDecision {
  const member = (room.members || []).find(m => m._id === player_id)
  if (!member) return { action: 'blocked', reason: '你不在该房间' }

  // 单人快开房：随时可离开（含游戏中——单人无对手，分数已实时上报），离开即销毁
  if (room.transient) return { action: 'destroy' }

  // 无尽挑战是常驻对局（死了可重生、随时能走），不套用"进行中禁止离开"
  const endlessArena = room.variant === 'endless'
  // 对局进行中禁止离开，避免中途离场造成房间/对局状态不一致
  if (room.status === constant.ROOM.STATUS.playing && !endlessArena) {
    return { action: 'blocked', reason: '游戏进行中不能离开，请先认输或等待对局结束' }
  }

  const remain = (room.members || []).filter(m => m._id !== player_id)
  const hasHuman = remain.some(m => m.player_type !== constant.PLAYER.TYPE.robot)
  // 可接手房主的真人对战玩家：跳过人机与观战者（观战者无法开局，接手会把房间卡死）
  const nextHumanOwner = remain.find(m =>
    m.player_type !== constant.PLAYER.TYPE.robot &&
    m.member_type === constant.MEMBER.TYPE.player
  )?._id

  if (room.official) {
    // 官方房只退出不解散。房主离开 → 转让给下一位真人对战玩家；无真人 → 空桌重置。
    const nextOwner = player_id === room.owner_id ? nextHumanOwner ?? '' : undefined
    return { action: 'leave', transferOwnerTo: nextOwner, reset: !hasHuman }
  }

  // 自建房房主离开：自动转让给非人机玩家；没有真人接手（只剩人机）则解散，人机随之被回收。
  // 不再要求房主手动转让或一键解散——房主走人后房间不该卡在无人认领状态。
  if (player_id === room.owner_id) {
    return nextHumanOwner
      ? { action: 'leave', transferOwnerTo: nextHumanOwner, reset: false }
      : { action: 'destroy' }
  }

  // 普通成员离开：无真人残留时回收机器人、清空成员（人机自动离开）
  return { action: 'leave', reset: !hasHuman }
}
