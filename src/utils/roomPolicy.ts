/**
 * 房间权限与流转决策 - 纯函数，无 DB 依赖，便于单测。
 *
 * 房主语义（SB-039）：
 * - 私有房：**创建者**才是房主，可以转让（只能转给非人机对战玩家）、可以直接解散；
 *   房主离开时转让给非人机玩家，没有就解散。
 * - 官方房：**只有临时房主**（房内第一位真人对战玩家），不可解散、不转让，只能离开；
 *   离开/被踢后交给下一位真人，没有真人则置空，空桌等下一批人。
 * - 人机（`player_type === 'robot'`）**永远不能持有房主**：人机进房传的
 *   `member_type` 也是 `player`，只看 member_type 会让第一台人机在空桌上当房主。
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

/** 可否成为房主的人：真人对战玩家（跳过人机与观战者） */
function canHoldOwnership(m?: PolicyMember | null): boolean {
  return !!m && m.player_type !== constant.PLAYER.TYPE.robot && m.member_type === constant.MEMBER.TYPE.player
}

/** 房间内第一位有资格当房主的人：官方房的「临时房主」候选，也是房主交接的唯一顺序 */
export function pickTempOwner(members?: PolicyMember[]): string {
  return (members || []).find(canHoldOwnership)?._id || ''
}

/** 当前 owner_id 是否是一个合法的真人对战玩家（人机房主 / 悬空房主都算否） */
export function hasHumanOwner(room: PolicyRoom): boolean {
  if (!room.owner_id) return false
  return canHoldOwnership((room.members || []).find(m => m._id === room.owner_id))
}

/**
 * 进房者是否应该接任房主。
 * - 私有房：创建时已写入（`createRoomWithOwner`），这里只兜底"房主不在成员表"的空壳房
 * - 官方房：只有临时房主 —— 目前没有真人房主时，由第一位真人对战玩家接任
 */
export function shouldTakeOwnership(room: PolicyRoom, joiner: PolicyMember): boolean {
  if (!canHoldOwnership(joiner)) return false
  if (room.official) return !hasHumanOwner(room)
  return (room.members || []).length === 0 || !room.owner_id
}

/**
 * 房主不变量校正：`owner_id` 必须是空的或房内的真人对战玩家。
 * 返回需要写入的新值；`null` 表示不需要改动。
 * 用于 seed 启动校正与 `reconcileRoom` 自愈 —— 历史脏数据里人机当过房主（SB-039）。
 */
export function normalizeOwner(room: PolicyRoom): string | null {
  if (!room.owner_id) return null
  if (hasHumanOwner(room)) return null
  return pickTempOwner(room.members)
}

export interface KickDecision {
  ok: boolean
  reason?: string
}

/**
 * 能否把某人踢出房间。
 * @param by 操作者 player_id；`undefined` 表示管理端/系统操作（无身份，豁免"必须是房主"）
 */
export function canKickMember(room: PolicyRoom, targetId: string, by?: string): KickDecision {
  const target = (room.members || []).find(m => m._id === targetId)
  if (!target) return { ok: false, reason: '成员不存在' }
  // 私有房主不能被踢：要么他自己解散，要么先转让 —— 否则房主凭空消失、房间没人能管
  if (!room.official && targetId === room.owner_id) {
    return { ok: false, reason: '私有房主不能被踢出，请先转让房主或解散房间' }
  }
  if (by !== undefined && by !== room.owner_id) {
    return { ok: false, reason: '只有房主可以踢人' }
  }
  return { ok: true }
}

/** 能否把房主转给 target：仅私有房主可转让，且目标必须是房内的非人机对战玩家 */
export function canTransferOwner(room: PolicyRoom, targetId: string, by?: string): KickDecision {
  if (room.official) {
    return { ok: false, reason: '官方房只有临时房主，不能转让（进出房自动交接）' }
  }
  if (by !== undefined && by !== room.owner_id) {
    return { ok: false, reason: '只有房主可以转让房主' }
  }
  const target = (room.members || []).find(m => m._id === targetId)
  if (!target) return { ok: false, reason: '对方不在房间里' }
  if (target.player_type === constant.PLAYER.TYPE.robot) {
    return { ok: false, reason: '不能把房主转让给人机' }
  }
  if (target.member_type !== constant.MEMBER.TYPE.player) {
    return { ok: false, reason: '不能把房主转让给观战者' }
  }
  return { ok: true }
}

/** 能否解散房间：官方房只有临时房主，永远不行；自建房仅房主 */
export function canDisbandRoom(room: PolicyRoom, requesterPlayerId: string): Decision {
  if (room.official) return { ok: false, reason: '官方房只有临时房主，不能解散，请退出房间' }
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
  const nextHumanOwner = pickTempOwner(remain) || undefined

  if (room.official) {
    // 无尽竞技房是常驻房：人机常驻场上陪玩，真人离开只走自己，
    // 不清场、不回收人机、不结束对局（否则真人一来一回就把陪玩清空了）。
    if (endlessArena) {
      const endlessOwner = player_id === room.owner_id ? nextHumanOwner ?? '' : undefined
      return { action: 'leave', transferOwnerTo: endlessOwner, reset: false }
    }
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

// ========== 遗留数据清理判定（纯函数，供服务启动自愈与单测共用） ==========

/**
 * 人机异常掉线后要不要把它从房间里摘掉。
 *
 * 背景：人机进程崩溃（典型事故：服务端快照改增量协议后，线上 robot 跑的还是旧代码，
 * 直读 `state.food` 抛 TypeError → 整个 robot 进程退出）时，它来不及发
 * `lobby:leave-room`，房间里会留下一条没人操控的僵尸蛇，账号也一直被占着。
 *
 * 只有人机走这条清理路径：
 * - 真人掉线只是掉线，位置留着（回来还能接着玩）；
 * - 不是房间成员（比如重连时房间已被解散）没什么可清的。
 */
export function shouldCleanupRobotOnDisconnect(
  room: Pick<PolicyRoom, 'members'> | null | undefined,
  player_id: string,
): boolean {
  const member = (room?.members || []).find(m => m._id === player_id)
  if (!member) return false
  return member.player_type === constant.PLAYER.TYPE.robot
}

export interface CleanupRoom {
  _id?: string
  status?: string
  match_id?: string
  members?: { _id: string }[]
}

export interface CleanupMatch {
  _id: string
  room_id?: string
  status?: string
}

/**
 * 玩家的 room_id 是否为悬空指针。
 * 三种情况都算悬空：
 * - 房间不存在
 * - 房间已软删（status=deleted）
 * - 房间还在，但玩家已不在成员表里（最隐蔽的一种：
 *   前端进游戏页会跳到这个房间，随后立刻弹出"已离开房间"）
 */
export function isDanglingRoomRef(
  player: { _id: string, room_id?: string },
  room: CleanupRoom | null | undefined,
): boolean {
  if (!player.room_id) return false
  if (!room) return true
  if (room.status === constant.ROOM.STATUS.deleted) return true
  return !(room.members || []).some(m => m._id === player._id)
}

/**
 * 对局是否是僵尸（房间已经回等待态 / 已解散 / 不存在，却仍停在 playing）。
 * 僵尸对局会让房间列表一直显示"对局中"，玩家点进去却玩不了。
 */
export function isZombieMatch(
  match: CleanupMatch,
  room: CleanupRoom | null | undefined,
): boolean {
  if (!room) return true
  if (room.status === constant.ROOM.STATUS.deleted) return true
  // 房间的 match_id 与对局对不上：说明房间已经开了新局或已重置
  return String(room.match_id || '') !== String(match._id)
}

/**
 * 房间是否是僵尸（停在 playing，但对局已不在进行中集合里）。
 */
export function isZombieRoom(room: CleanupRoom, playingMatchIds: Set<string>): boolean {
  if (room.status !== constant.ROOM.STATUS.playing) return false
  if (!room.match_id) return false
  return !playingMatchIds.has(String(room.match_id))
}
