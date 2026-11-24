/**
 * 机器人（人机）服务：把"占用一个机器人账号 → 让 robot 服务拉起 bot"这条链路收在一处。
 *
 * 两条调用方共用同一段逻辑：
 * - 房主手动点"添加人机"（RoomHandler.addRobot）
 * - 服务启动时给官方桌补人机（ensureRoomBots）
 */
import { MGame, MPlayer, MRoom, MUser } from '../models';
import constant from '../constant';
import config from '../config';
import { TicketTool } from '../utils';

const ticketHelper = new TicketTool(config.secret);

export interface AddRobotResult {
  ok: boolean;
  message: string;
  /** 实际加入的机器人 player_id（失败时为空） */
  player_id?: string;
}

/**
 * 往房间里加一个机器人。
 * @param room_id 目标房间
 * @param options.ignoreLimit 忽略"每房机器人上限"（官方桌补人机时用）
 */
export async function addRobotToRoom(room_id: string, options: { ignoreLimit?: boolean } = {}): Promise<AddRobotResult> {
  const room = await MRoom.findById(room_id).lean(true);
  if (!room) return { ok: false, message: '房间不存在' };

  const game = await MGame.findById(room.game_id, { slug: 1 }).lean(true);
  if (!game) return { ok: false, message: '游戏不存在' };

  // 限制每个房间的机器人数量（固定房模式，避免机器人无限堆叠）
  if (!options.ignoreLimit) {
    const robotCount = room.members.filter(m => m.player_type === constant.PLAYER.TYPE.robot).length;
    if (robotCount >= config.max_robot_per_room) {
      return { ok: false, message: '本房间机器人数量已达上限' };
    }
  }

  // 原子占用一个在线机器人（state online -> matching），防止并发重复分配同一个账号。
  // 只有种子数据里 type=robot/state=online 的账号会被选中。
  const claimed = await MPlayer.findOneAndUpdate(
    { game_id: room.game_id, type: constant.PLAYER.TYPE.robot, state: constant.PLAYER.STATE.online },
    { $set: { state: constant.PLAYER.STATE.matching, updatedAt: new Date() } },
    { sort: { level: -1 }, new: true },
  ).lean(true);
  if (!claimed) return { ok: false, message: '暂无空闲机器人' };

  const user = await MUser.findById(claimed.user_id).lean(true);
  if (!user) {
    await releaseClaim(claimed._id);
    return { ok: false, message: '机器人账号异常' };
  }

  // 回滚占用：把机器人放回 online 池
  const rollback = async () => {
    await MPlayer.updateOne({ _id: claimed._id }, { $set: { state: constant.PLAYER.STATE.online, room_id: '' } });
  };

  try {
    const ticket = ticketHelper.encrypt(JSON.stringify({ user_id: claimed.user_id, player_id: claimed._id }));
    const resp = await fetch(`${config.robot_url}/add-robot`, {
      method: 'post',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        player_id: claimed._id,
        slug: game.slug,
        serverUrl: config.server_ws_url,
        ticket,
        room_id,
      }),
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok || body?.code !== 0) {
      await rollback();
      return { ok: false, message: '机器人服务不可用' };
    }
    // 机器人服务已接受，bot 会带着 ticket 自行 join-room（joinRoom 会把 state 置为 inroom）
    return { ok: true, message: '已添加人机', player_id: claimed._id };
  } catch (error) {
    console.error('❌ 添加机器人失败:', error);
    await rollback();
    return { ok: false, message: '机器人服务不可用' };
  }
}

export async function releaseClaim(player_id: string) {
  await MPlayer.updateOne({ _id: player_id }, { $set: { state: constant.PLAYER.STATE.online, room_id: '' } });
}

/**
 * 给指定房间补足机器人到 target 个（只补差量，幂等）。
 * robot 服务不可用时静默跳过：不能因为人机服务没起来就让整个 API 起不来。
 */
export async function ensureRoomBots(room_id: string, target: number): Promise<number> {
  const room = await MRoom.findById(room_id).lean(true);
  if (!room) return 0;
  const current = room.members.filter(m => m.player_type === constant.PLAYER.TYPE.robot).length;
  let added = 0;
  for (let i = current; i < target; i++) {
    const res = await addRobotToRoom(room_id, { ignoreLimit: true });
    if (!res.ok) {
      if (added === 0) console.warn(`🤖 房间 ${room_id} 补人机失败：${res.message}`);
      break;
    }
    added++;
  }
  if (added) console.log(`🤖 房间 ${room_id} 已补充 ${added} 个人机（目标 ${target}）`);
  return added;
}
