/**
 * 房间管理服务 - 支持密码和自动解散
 */

import { v7 } from 'uuid';
import { IRoom, IPlayer, IMember } from '../types/index';
import { MGame, MMatch, MPlayer, MRoom } from '../models'
import { isEmpty, sumBy } from 'lodash';
import redis from '../utils/redis'
import config from '../config';
import constant, { MemberType, PlayerType } from '../constant'
import GameLogics from '../games'
import { normalizeTimeControl, buildMatchTimeControl } from '../utils/timeControl'
import {
  canKickMember,
  canSpectate,
  canTransferOwner,
  normalizeOwner,
  pickTempOwner,
  resolveLeaveAction,
  shouldTakeOwnership,
} from '../utils/roomPolicy'
import { snakeRuntimeService } from './SnakeRuntimeService';

export class RoomService {

  /** 房间数变化后失效统计缓存，避免解散/创建后"活跃房间"6 小时内一直显示旧值 */
  private async invalidateStats() {
    await redis.del(config.prefix + 'stats:room').catch(() => { /* 缓存失效失败不影响主流程 */ });
  }

  /**
   * 创建房间 - 支持密码
   */
  async createRoom(data: Partial<IRoom>) {
    data._id = v7();
    data.status = constant.ROOM.STATUS.waiting;
    data.createdAt = new Date();
    data.updatedAt = new Date();

    await MRoom.create(data);
    await this.invalidateStats();

    console.log(`✨ 房间创建: ${data._id} (${data.name}) ${data.isPrivate ? '🔒 私密' : '🔓 公开'}`);
    return data;
  }

  /**
   * 创建房间并让房主作为第一个玩家入房。
   * 保证 rooms.members 与 players.state/room_id 在同一次操作里一致，
   * 否则房主不在成员列表、state 停在 online，前端既不显示"准备"也无法开始游戏。
   */
  async createRoomWithOwner(data: Partial<IRoom>, owner: IPlayer): Promise<IRoom> {
    const room = await this.createRoom(data);

    const member: IMember = {
      _id: owner._id,
      player_type: owner.type as PlayerType,
      member_type: constant.MEMBER.TYPE.player,
      role: '',
      team: '',
    };
    const game = await MGame.findById(room.game_id).lean(true);
    if (game) {
      GameLogics[game.slug]?.assignRole(room, member);
    }

    await MRoom.updateOne({ _id: room._id }, { $set: { members: [member] } });
    // 房主进房即视为已准备：房间内所有真人玩家统一自动准备，开局完全由房主点"开始游戏"控制。
    await MPlayer.updateOne({ _id: owner._id }, {
      $set: {
        room_id: room._id,
        state: constant.PLAYER.STATE.prepared,
      },
    });

    return { ...room, members: [member] };
  }

  /**
   * 获取房间
   */
  async getRoomById(room_id: string): Promise<IRoom | null> {
    const room = await MRoom.findById(room_id).lean(true);
    return room || null;
  }

  /**
   * 房间自愈：把「房间」与「玩家 / 对局」之间漂移的状态修回来，返回修好后的房间。
   *
   * 两类脏数据都会让玩家卡进一个"打不了"的房间：
   * - **悬空成员**：members 里指向的玩家记录已被删除（例如清理测试号），
   *   玩家列表会渲染出一个空白名字，而且把房间人数撑成"有人"→ 匹配优先选它；
   * - **幽灵对局**：status=playing 但找不到进行中的对局（对局已结算 / 对局记录丢失），
   *   前端会照样渲染对局画布，却永远收不到快照，表现为「一直显示连接中」。
   */
  async reconcileRoom(room_id: string): Promise<any | null> {
    const room = await MRoom.findById(room_id).lean(true) as any;
    if (!room || room.status === constant.ROOM.STATUS.deleted) return null;

    const ids: string[] = (room.members || []).map((m: any) => String(m._id));
    if (ids.length) {
      const alive = await MPlayer.find({ _id: { $in: ids } }, { _id: 1 }).lean(true);
      const aliveIds = new Set(alive.map(p => String(p._id)));
      const ghosts = (room.members || []).filter((m: any) => !aliveIds.has(String(m._id)));
      if (ghosts.length) {
        await MRoom.updateOne(
          { _id: room_id },
          { $pull: { members: { _id: { $in: ghosts.map((g: any) => g._id) } } } } as any,
        );
        room.members = room.members.filter((m: any) => aliveIds.has(String(m._id)));
        console.log(`🧹 房间 ${room_id} 清理 ${ghosts.length} 个悬空成员（玩家记录已不存在）`);
      }
    }

    // 房主不变量自愈（SB-039）：官方房只有临时房主，owner_id 必须是房内的真人对战玩家。
    // 历史脏数据里人机当过房主（管理端永远踢不掉它），这里顺手纠正成「第一位真人」或置空。
    if (room.official) {
      const wantOwner = normalizeOwner(room as any);
      if (wantOwner !== null && wantOwner !== room.owner_id) {
        await MRoom.updateOne({ _id: room_id }, { $set: { owner_id: wantOwner } });
        console.log(`🧹 房间 ${room_id} 的临时房主由 ${room.owner_id || '空'} 校正为 ${wantOwner || '空'}`);
        room.owner_id = wantOwner;
      }
    }

    if (room.status === constant.ROOM.STATUS.playing) {
      const live = room.match_id
        ? await MMatch.findOne(
          { _id: room.match_id, status: constant.MATCH.STATUS.playing },
          { _id: 1 },
        ).lean(true)
        : await MMatch.findOne(
          { room_id, status: constant.MATCH.STATUS.playing },
          { _id: 1 },
        ).lean(true);
      if (!live) {
        // 房间停在 playing 但没有对局 → 重置回等待，否则前端一直等一个不存在的快照
        await MRoom.updateOne(
          { _id: room_id, status: constant.ROOM.STATUS.playing },
          { $set: { status: constant.ROOM.STATUS.waiting, match_id: '', updatedAt: new Date() } },
        );
        room.status = constant.ROOM.STATUS.waiting;
        room.match_id = '';
        console.log(`🧹 房间 ${room_id} 处于 playing 但无进行中的对局，已重置为等待`);
      } else if (String(room.match_id) !== String(live._id)) {
        room.match_id = live._id;
      }
    }
    return room;
  }

  /** 同一房间的自动开局去重（单进程权威，避免匹配/进房两条路径同时建局） */
  private arenaLocks = new Map<string, Promise<{ match_id: string, started: boolean }>>();

  /**
   * 保证贪吃蛇房间是"可玩"的：
   * - 房间在局中但服务端运行时已丢失（重启、异常退出）→ 按库里局面重建 tick；
   * - 无尽竞技房是常开对局：只要房里有玩家且还没开局，就直接开（进房即开局，
   *   回房/刷新同样成立，不会停在"等待开局"的空白画面）。
   *
   * 非贪吃蛇房间一律返回空，调用方按原逻辑处理。
   */
  async ensureSnakeArena(room_id: string): Promise<{ match_id: string, started: boolean }> {
    const running = this.arenaLocks.get(room_id);
    if (running) return running;
    const task = this.doEnsureSnakeArena(room_id).finally(() => this.arenaLocks.delete(room_id));
    this.arenaLocks.set(room_id, task);
    return task;
  }

  private async doEnsureSnakeArena(room_id: string): Promise<{ match_id: string, started: boolean }> {
    const room = await MRoom.findById(room_id).lean(true) as any;
    if (!room || room.status === constant.ROOM.STATUS.deleted) return { match_id: '', started: false };
    const game = await MGame.findById(room.game_id, { slug: 1 }).lean(true) as any;
    if (!game || game.slug !== 'snake') return { match_id: '', started: false };

    if (room.status === constant.ROOM.STATUS.playing && room.match_id) {
      if (!snakeRuntimeService.has(room.match_id)) {
        const match = await MMatch.findById(room.match_id).lean(true) as any;
        if (match && match.status === constant.MATCH.STATUS.playing) {
          // 只按"仍在房间里的成员"重建：离场玩家的记录如果还残留在对局文档里
          // （历史脏数据 / 旧代码没清），直接 spawn 会给已经退出的人刷出一条幽灵蛇
          const memberIds = new Set((room.members || []).map((m: any) => String(m._id)));
          const currPlayers: any[] = match.curr_state?.players || [];
          const alive = currPlayers.filter((p: any) => memberIds.has(String(p._id)));
          if (alive.length !== currPlayers.length) {
            match.curr_state = { ...match.curr_state, players: alive };
            void MMatch.updateOne({ _id: match._id }, { $set: { 'curr_state.players': alive } } as any)
              .catch((error: any) => console.log('❌ 清理对局幽灵成员失败:', error));
          }
          snakeRuntimeService.spawn(match);
          console.log(`🐍 房间 ${room_id} 的运行时缺失，已按库里局面重建 match=${room.match_id}`);
        }
      }
      return { match_id: room.match_id, started: false };
    }

    // 只有无尽竞技房"进房即开局"；多人对战必须等房主点开始
    if (room.settings?.variant !== 'endless') return { match_id: '', started: false };
    const players = (room.members || []).filter((m: any) => m.member_type === MemberType.player);
    if (!players.length) return { match_id: '', started: false };

    const match_id = await this.startGame(room_id);
    if (!match_id) return { match_id: '', started: false };
    const started = await MMatch.findById(match_id).lean(true) as any;
    if (started) snakeRuntimeService.spawn(started);
    console.log(`🐍 无尽竞技房 ${room_id} 自动开局，match=${match_id}`);
    return { match_id, started: true };
  }

  /**
   * 获取游戏的所有房间
   * 口径与 GameService.getAllGames 的房间计数一致：返回未解散（非 deleted）且非临时（单人快开）的房间，
   * 含 waiting / playing——进行中的房间前端显示"加入"禁用、可"观看"，避免数量与列表不一致。
   */
  async getRoomsByGameId(game_id: string): Promise<IRoom[]> {
    const rooms = await MRoom.find({
      game_id,
      status: { $ne: constant.ROOM.STATUS.deleted },
      transient: { $ne: true },
    }).lean(true);
    return rooms;
  }

  /**
   * 获取所有房间（不含临时房）
   */
  async getAllRooms(): Promise<IRoom[]> {
    const rooms = await MRoom.find({
      status: { $ne: constant.ROOM.STATUS.deleted },
      transient: { $ne: true },
    }).lean(true);
    return rooms;
  }

  /**
   * 验证房间密码
   */
  async verifyPassword(room_id: string, password: string) {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return false;

    if (!room.isPrivate) return true; // 公开房间无需密码

    return room.password === password;
  }

  /**
   * 玩家加入房间 - 支持密码验证
   * - 临时房（单人快开）不对外人开放（已在房内的成员重连除外）
   * - 观战需房间 allowSpectate 未关闭
   */
  async joinRoom(data: { room_id: string, type: MemberType, password?: string }, player: IPlayer): Promise<{ success: boolean, newPlayer?: IMember, reason?: string }> {
    const room = await MRoom.findById(data.room_id).lean(true);
    if (!room) return { success: false, reason: '房间不存在' };
    const game = await MGame.findById(room.game_id).lean(true)
    if (!game) return { success: false, reason: '游戏不存在' };

    // 检查玩家是否已在房间中（幂等：返回现有 member，并补偿同步 MPlayer 状态）
    const existing = room.members.find(p => p._id === player._id);
    if (existing) {
      // 观战者 watching，其余玩家进房即 prepared（与 createRoomWithOwner 对齐）。
      await MPlayer.updateOne({ _id: player._id }, {
        $set: {
          room_id: data.room_id,
          state: data.type === constant.MEMBER.TYPE.viewer
            ? constant.PLAYER.STATE.watching
            : constant.PLAYER.STATE.prepared,
        }
      });
      return { success: true, newPlayer: existing };
    }
    // 临时房（单人快开）不进列表也不对外人开放
    if (room.transient) {
      console.log(`❌ 临时房间不可加入: ${data.room_id}`);
      return { success: false, reason: '该房间不可加入' };
    }
    // 观战开关：allowSpectate === false 时禁止以观战身份进入
    if (data.type === constant.MEMBER.TYPE.viewer && !canSpectate(room)) {
      console.log(`❌ 房间禁止观战: ${data.room_id}`);
      return { success: false, reason: '该房间不允许观战' };
    }
    const players = room.members.filter(m => m.member_type === constant.MEMBER.TYPE.player);
    if (data.type === constant.MEMBER.TYPE.player) {
      // 检查房间是否已满
      if (players.length >= room.numbers.max) {
        console.log(`❌ 房间已满: ${data.room_id}`);
        return { success: false, reason: '房间已满' };
      }

      // 检查房间状态：无尽挑战是常驻竞技房，开局后仍可随时进出
      const endlessArena = room.settings?.variant === 'endless';
      if (room.status !== constant.ROOM.STATUS.waiting && !endlessArena) {
        console.log(`❌ 房间游戏已开始: ${data.room_id}`);
        return { success: false, reason: '房间游戏已开始' };
      }

    }
    // 验证密码（verifyPassword 是异步方法，必须 await，否则 !Promise 恒为 false 导致密码校验被绕过）
    if (room.isPrivate && !(await this.verifyPassword(data.room_id, data.password || ''))) {
      console.log(`❌ 房间密码错误: ${data.room_id}`);
      return { success: false, reason: '房间密码错误' };
    }
    const newPlayer = { _id: player._id, player_type: player.type as PlayerType, member_type: data.type, role: '', team: '' }
    GameLogics[game.slug].assignRole(room, newPlayer)
    // 团队模式：6 队 × 每队 5 人，队满即不可再入座（assignRole 分不到队时返回空 team）
    if (data.type === constant.MEMBER.TYPE.player && room.settings?.variant === 'team' && !newPlayer.team) {
      console.log(`❌ 团队模式已满员: ${data.room_id}`);
      return { success: false, reason: '所有队伍已满' };
    }
    // 原子追加成员（$push）而不是整数组覆盖（$set）：
    // 官方房开局时 5 个人机同时进房，整数组覆盖会互相踩掉（最后写入者赢），
    // 表现为"补了 5 个人机，房间里只剩 3 个"。
    // 'members._id': {$ne} 保证同一个人重复进房不会插入两条。
    const update: Record<string, any> = { $push: { members: newPlayer } };
    // 房主（SB-039）：
    // - 私有房：创建者已在 createRoomWithOwner 里写入，这里只兜底空壳房
    // - 官方房：只有「临时房主」= 房内第一位真人对战玩家；人机永远不接任
    //   （人机进房传的 member_type 也是 'player'，不按 player_type 过滤会让它当上房主）
    if (shouldTakeOwnership(room as any, newPlayer as any)) {
      update.$set = { owner_id: player._id };
    }
    await MRoom.updateOne({ _id: room._id, 'members._id': { $ne: player._id } }, update);
    // 真人玩家进房自动准备；观战者不计入准备，状态为 watching。
    await MPlayer.updateOne({ _id: player._id }, {
      $set: {
        room_id: data.room_id,
        state: data.type === constant.MEMBER.TYPE.viewer
          ? constant.PLAYER.STATE.watching
          : constant.PLAYER.STATE.prepared,
      }
    })
    const updated = await MRoom.findById(room._id, { 'members._id': 1 }).lean(true);
    console.log(`👤 玩家 ${player._id} 加入房间 ${data.room_id}，当前人数: ${updated?.members?.length || 0}`);
    return { success: true, newPlayer };
  }

  /**
   * 玩家离开房间。流转规则见 utils/roomPolicy.resolveLeaveAction：
   * - 单人快开房（transient）：随时可离开，离开即销毁。
   * - 游戏进行中（playing）禁止离开（临时房除外），需认输/等对局结束。
   * - 自建房：房主离开即解散。
   * - 官方房：只退出不解散；房主离开转让房主，空房重置保留（空桌复用）。
   * - 普通成员离开：仅移除自己；房间内已无真人时一并回收机器人。
   */
  async leaveRoom(room_id: string, player_id: string): Promise<{ ok: boolean, dissolved?: boolean, reason?: string }> {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return { ok: false, reason: '房间不存在' };

    const variant = room.settings?.variant as string | undefined;
    const endlessArena = variant === 'endless';
    const decision = resolveLeaveAction({ ...room, variant }, player_id);
    if (decision.action === 'blocked') {
      return { ok: false, reason: decision.reason };
    }
    // 无尽模式：任何离开路径（最后一人退出 / 房主解散 / 普通离房）都要先把分数同步到榜单。
    // 死亡那一 tick 已记过一次，$max 幂等；这里主要覆盖"还活着就点离开/关闭"的情况。
    const liveMatch = endlessArena && room.match_id ? room.match_id : '';
    if (liveMatch) {
      await snakeRuntimeService.syncScore(liveMatch, player_id);
      // 解散时房间会立刻销毁运行时，不需要再单独移蛇
      if (decision.action !== 'destroy') snakeRuntimeService.removePlayer(liveMatch, player_id);
    }

    // 离开即销毁（临时房 / 自建房房主离开）
    if (decision.action === 'destroy') {
      await this.destroyRoom(room_id);
      return { ok: true, dissolved: true };
    }

    // 仅退出：reset 表示离开后房间内已无真人 → 清空成员并回收机器人
    const remainMembers = decision.reset
      ? room.members.filter(m => m._id !== player_id && m.player_type !== constant.PLAYER.TYPE.robot)
      : room.members.filter(m => m._id !== player_id);
    const set: Partial<IRoom> & { updatedAt: Date } = { members: remainMembers, updatedAt: new Date() };
    if (decision.transferOwnerTo !== undefined) {
      set.owner_id = decision.transferOwnerTo;
    }
    if (decision.reset) {
      // 空房回等待态；官方空桌重置房主，等待下一位玩家接任
      set.status = constant.ROOM.STATUS.waiting;
      set.match_id = '';
      if (room.official) set.owner_id = '';
    }
    await MRoom.updateOne({ _id: room._id }, { $set: set })
    await MPlayer.updateOne({ _id: player_id }, { $set: { room_id: '', state: constant.PLAYER.STATE.online } })
    console.log(`👤 玩家 ${player_id} 离开房间 ${room_id}，当前人数: ${remainMembers.length}${decision.reset ? '（空房重置）' : ''}`);

    if (decision.reset) {
      // 无尽模式没人了：结束这一局并按各自最高分结算（房间已回等待态，幂等）
      if (liveMatch) await snakeRuntimeService.stopAndFinish(liveMatch);
      const robotIds = room.members.filter(m => m.player_type === constant.PLAYER.TYPE.robot).map(m => m._id);
      if (robotIds.length) {
        // 复位机器人状态，使其可被其他房间重新占用
        await MPlayer.updateMany(
          { _id: { $in: robotIds } },
          { $set: { room_id: '', state: constant.PLAYER.STATE.online } }
        );
        await Promise.allSettled(robotIds.map(id =>
          fetch(`${config.robot_url}/rem-robot`, {
            method: 'post',
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ player_id: id }),
          })
        ));
      }
    }

    return { ok: true, dissolved: false };
  }

  /**
   * 踢人出房。规则见 `utils/roomPolicy.canKickMember`：
   * - 私有房主不可被踢（要么转让，要么解散整个房间）
   * - 官方房只有临时房主，临时房主同样可被踢，踢后房主交给下一位真人
   * - `by` 为空表示管理端/系统操作（豁免"必须是房主"的身份校验）
   */
  async kickPlayer(room_id: string, player_id: string, by?: string): Promise<{ ok: boolean; reason?: string }> {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return { ok: false, reason: '房间不存在' };
    const check = canKickMember(room as any, player_id, by);
    if (!check.ok) return { ok: false, reason: check.reason };
    const member = room.members.find(m => m._id === player_id)!;

    const remain = room.members.filter(m => m._id !== player_id);
    const set: Record<string, any> = { members: remain, updatedAt: new Date() };
    // 房主被踢（官方房临时房主 / 历史人机房主）→ 立刻交给下一位真人，没有真人就置空
    if (player_id === room.owner_id) set.owner_id = pickTempOwner(remain);
    await MRoom.updateOne({ _id: room_id }, { $set: set });
    await MPlayer.updateOne({ _id: member._id }, { $set: { state: constant.PLAYER.STATE.online, room_id: '' } })
    // 对局进行中踢人：必须同时把这条蛇从内存运行时里摘掉。
    // 只删 room.members 的话，快照里还会带着它（无尽模式显示成"等待重生"的僵尸蛇），
    // 而且它一直占着场上的位置。removePlayer 会顺带结算分数并同步库里对局成员。
    if (room.match_id && room.status === constant.ROOM.STATUS.playing) {
      snakeRuntimeService.removePlayer(room.match_id, player_id);
    }
    if (member.player_type === constant.PLAYER.TYPE.robot) {
      await fetch(`${config.robot_url}/rem-robot`, {
        method: 'post',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          player_id: member._id,
        }),
      }).then(async (resp) => {
        const body = await resp.json()
      }).catch(err => {
        console.log(err);
      });
    }
    return { ok: true };
  }
  /** 转让房主：仅私有房主可转让，目标必须是房内的非人机对战玩家（SB-039） */
  async transferOwner(room_id: string, player_id: string, by?: string): Promise<{ ok: boolean; reason?: string }> {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return { ok: false, reason: '房间不存在' };
    const check = canTransferOwner(room as any, player_id, by);
    if (!check.ok) return { ok: false, reason: check.reason };
    await MRoom.updateOne({ _id: room_id }, { $set: { owner_id: player_id, updatedAt: new Date() } });
    return { ok: true };
  }
  /**
   * 开始游戏
   */
  async startGame(room_id: string) {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return '';
    console.log('start game')
    const game = await MGame.findById(room.game_id).lean(true);
    if (!game) {
      return '';
    }
    const players = room.members.filter(m => m.member_type === constant.MEMBER.TYPE.player);

    if (players.length < room.numbers.min) {
      return '';
    }
    const state = GameLogics[game.slug].getInitState();
    // 象棋 getInitState 不返回 first，默认由 role=red 的玩家先手。
    const firstRole = state.first || 'red';
    const match_id = v7();
    const curr_turn = players.find(p => p.role === firstRole)?._id
      || players.find(p => p.role === 'black' || p.role === 'white')?._id
      || players[0]?._id || '';

    // 象棋计时：开局时把房间配置固化为对局快照（读秒制：每步限时，超时扣总额度）。
    // 仅对配置了 timeControl.enabled 的房间生效；快照写入对局状态，后续不再依赖房间设置。
    const assigned = GameLogics[game.slug]?.assignRoles(players);
    const config = normalizeTimeControl(room.settings?.timeControl);
    const timeControl = config.enabled
      ? buildMatchTimeControl(config, players.map(p => p._id), Date.now())
      : undefined;

    // 玩法变体（如贪吃蛇 endless/team）：写入对局状态，供服务端/客户端判定玩法与分榜
    const variant = room.settings?.variant as string | undefined;
    const variantState = variant ? { variant } : {};

    await MMatch.create({
      _id: match_id,
      game_id: room.game_id,
      room_id: room._id,
      status: constant.MATCH.STATUS.playing,
      init_state: { ...state, players, ...variantState, ...(timeControl ? { timeControl } : {}) },
      curr_state: { ...state, players, curr_turn, ...variantState, ...(timeControl ? { timeControl } : {}) },
      players: assigned,
      createdAt: new Date(),
      updatedAt: new Date(),
      stats: {},
    })

    await MRoom.updateOne({ _id: room_id }, {
      $set: {
        match_id,
        status: constant.ROOM.STATUS.playing,
        startedAt: new Date(),
      }
    })
    await MPlayer.bulkWrite(room.members.map(m => ({
      updateOne: {
        filter: { _id: m._id },
        update: {
          $set: {
            state: m.member_type === MemberType.viewer ? constant.PLAYER.STATE.watching : constant.PLAYER.STATE.ingame,
            room_id: room._id,
          }
        }
      }
    })))
    console.log(`🎮 房间 ${room_id} 开始游戏，玩家数: ${players.length}`);
    return match_id;
  }

  /**
   * 单人游戏实时记录最高分（不结算、不改对局状态）。
   * 用 $max 写入 MPlayer.score 与分榜 MPlayer.boards[board]：
   * 排行榜展示的是"该玩法历史最高分"，中途退出也不会丢分，且重复上报幂等。
   * @param board 分榜 key（如贪吃蛇 endless）；缺省只写总分（2048/俄罗斯方块等）
   */
  async recordSoloScore(player_id: string, score: number, board?: string): Promise<boolean> {
    if (!Number.isFinite(score) || score < 0) return false;
    const max: Record<string, number> = { score: Math.floor(score) };
    if (board) max[`boards.${board}`] = Math.floor(score);
    const res = await MPlayer.updateOne(
      { _id: player_id },
      { $max: max }
    );
    return res.modifiedCount > 0; // true 表示刷新了历史最高分
  }

  /**
   * 对局结算（幂等）。
   * @param winner_player_id 胜者 player_id；'' 表示平局（对战游戏）。单人游戏可传自己。
   * @param scores 可选：显式分数表 { player_id: score }。用于单人游戏上报本局得分 /
   *               斗地主队伍计分。提供时以此为准写入 MMatch/MPlayer.score，
   *               不再使用 ±1。
   * @param scoreMode 'inc'（默认，累加到 MPlayer.score）| 'max'（取历史最高分，
   *                  用于单人游戏，保证排行榜展示最佳成绩且实时上报不重复累加）。
   * @param board 可选分榜 key（多人贪吃蛇 team 等）：结算时同时用 $max 写入
   *              MPlayer.boards[board]，让分榜展示"该玩法单局最高分"。
   */
  async gameover(
    room_id: string,
    match_id: string,
    winner_player_id: string,
    scores?: Record<string, number>,
    scoreMode: 'inc' | 'max' = 'inc',
    board?: string,
  ) {
    const room = await MRoom.findOne({ _id: room_id }, { members: 1 }).lean(true);
    if (!room) {
      return;
    }
    const match = await MMatch.findOne({ _id: match_id }).lean(true);
    if (!match) {
      return;
    }

    // 幂等保护：只有把对局从 playing 原子地改成 gameover 成功的这一次调用才做结算。
    // 避免 game 逻辑层（如象棋吃将）与服务层重复加分、重复改状态。
    if (match.status === constant.MATCH.STATUS.gameover) {
      return;
    }
    // 有显式分数表时用之；否则沿用对战游戏的 ±1/平局 0 语义。
    const scoreOf = (pid: string) => scores
      ? (scores[pid] ?? 0)
      : (winner_player_id ? (pid === winner_player_id ? 1 : -1) : 0);
    // 团队模式（贪吃蛇 team）：胜者是"一支队伍"，队内成员共享胜负。
    // winner_player_id 传的是该队贡献最高分的成员，据此推出全队名单。
    const winnerTeam = winner_player_id
      ? (match.players || []).find((p: any) => p._id === winner_player_id)?.team || ''
      : '';
    const isTeamMatch = !!winnerTeam && board === 'team';
    const winnerIds = new Set<string>();
    if (winner_player_id) winnerIds.add(winner_player_id);
    if (isTeamMatch) {
      for (const p of (match.players || []) as any[]) {
        if (p.team === winnerTeam) winnerIds.add(p._id);
      }
    }
    const claim = await MMatch.updateOne(
      { _id: match._id, status: constant.MATCH.STATUS.playing },
      {
        $set: {
          status: constant.MATCH.STATUS.gameover,
          updatedAt: new Date(),
          players: match.players.map(p => ({
            ...p,
            score: scoreOf(p._id),
            is_winner: winnerIds.has(p._id),
          })),
          ...(scores ? { 'stats.scores': scores } : {}),
          ...(isTeamMatch ? { 'stats.winner_team': winnerTeam } : {}),
        }
      }
    );
    if (!claim.modifiedCount) {
      return;
    }

    // 房间回到等待；所有真人玩家与机器人统一回到 prepared（观战者保持 watching）。
    // 开局由房主点"开始游戏"控制，对局结束后直接处于已准备状态，便于再次开局。
    await MRoom.updateOne(
      { _id: room_id },
      {
        $set: {
          status: constant.ROOM.STATUS.waiting,
          match_id: '',
          updatedAt: new Date(),
        }
      });
    await MPlayer.bulkWrite(room.members.map(m => {
      const isPlayer = m.member_type === MemberType.player;
      // 单人游戏（scoreMode='max'）：score 取历史最高分，与其他对局累加语义区分开。
      const useMax = isPlayer && !!scores && scoreMode === 'max';
      // 分榜：无论 inc/max，都按"该玩法单局最高分"记录（贪吃蛇多人榜）
      const maxFields: Record<string, number> = {};
      if (useMax) maxFields.score = Math.floor(scoreOf(m._id));
      if (isPlayer && scores && board) {
        maxFields[`boards.${board}`] = Math.floor(scoreOf(m._id));
      }
      return {
        updateOne: {
          filter: { _id: m._id },
          update: {
            $set: {
              state: m.member_type === MemberType.viewer
                ? constant.PLAYER.STATE.watching
                : constant.PLAYER.STATE.prepared,
            },
            // $set 与 $inc 必须分层，混用会触发 MongoServerError: Unknown modifier
            $inc: {
              ...(isPlayer ? {
                'stats.games': 1,
                'stats.matches': 1,
                // 平局（winner 为空且无显式分数）不再扣分——修复原有不一致：
                // MMatch.players[].score 写 0 而 MPlayer.score 却 -1。
                ...(useMax ? {} : { score: scoreOf(m._id) }),
                // 团队模式：整支获胜队伍都记一次胜场；其他情况沿用单人胜者语义
                'stats.winners': isTeamMatch
                  ? (winnerIds.has(m._id) ? 1 : 0)
                  : (scores ? 0 : (winner_player_id && m._id === winner_player_id ? 1 : 0)),
              } : {}),
            },
            ...(Object.keys(maxFields).length ? { $max: maxFields } : {}),
          },
        },
      };
    }));
  }

  /**
   * 销毁房间。官方公共房不允许销毁（只能退出，空桌保留复用）。
   */
  async destroyRoom(room_id: string) {
    const room = await MRoom.findById(room_id).lean(true);
    if (!room) return;
    if (room.official) {
      // 兜底保护：官方房即使被误调用也不销毁
      console.log(`⚠️  官方房间不可解散，已忽略: ${room_id}`);
      return;
    }
    await MRoom.updateOne({ _id: room_id }, { $set: { status: constant.ROOM.STATUS.deleted } });
    if (room.match_id) snakeRuntimeService.stop(room.match_id);
    await this.invalidateStats();
    if (room.members?.length) {
      const memberIds = room.members.map(m => m._id);
      // 释放房间内所有真人玩家，避免其 room_id 悬空导致刷新后无法回房/无法进入新房间
      await MPlayer.updateMany(
        { _id: { $in: memberIds }, type: constant.PLAYER.TYPE.player },
        { $set: { room_id: '', state: constant.PLAYER.STATE.online } }
      );
      // 回收机器人：复位为 online 并清空 room_id，否则两个机器人用一次后永远无法再被 addRobot 选中
      const robotIds = room.members.filter(m => m.player_type === constant.PLAYER.TYPE.robot).map(m => m._id);
      if (robotIds.length) {
        await MPlayer.updateMany(
          { _id: { $in: robotIds } },
          { $set: { room_id: '', state: constant.PLAYER.STATE.online } }
        );
        // 通知 robot 服务移除 bot 实例
        await Promise.allSettled(robotIds.map(id =>
          fetch(`${config.robot_url}/rem-robot`, {
            method: 'post',
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ player_id: id }),
          })
        ));
      }
    }
    console.log(`🗑️  房间解散: ${room_id}`);
    return room;
  }

  async playerReady(room: IRoom, ready: boolean, player_id: string) {
    console.log(`切换准备状态`, player_id, ready)
    await MPlayer.updateOne({ _id: player_id }, { $set: { state: ready ? constant.PLAYER.STATE.prepared : constant.PLAYER.STATE.inroom } });
    return true;
  }
  /**
   * 房间是否已可开局（所有真人玩家都已 prepared 且达到人数下限）。
   * 仅用于前端展示"已就绪"，不修改房间状态、更不触发开局——
   * 开局一律由房主显式点"开始游戏"控制（避免自动化导致房主来不及操作）。
   */
  async roomReady(room: IRoom) {
    const ids = room.members.filter(m => m.member_type === constant.MEMBER.TYPE.player).map(m => m._id);
    const players = await MPlayer.find({ _id: { $in: ids } }, { state: 1 }).lean(true)
    const readys = sumBy(players, p => p.state === constant.PLAYER.STATE.prepared ? 1 : 0);
    return readys === players.length && readys >= room.numbers.min;
  }

  /**
   * 获取房间统计
   */
  async getStats() {
    const key = config.prefix + 'stats:room'
    let stats: { [key: string]: string | number } = await redis.hgetall(key)
    if (isEmpty(stats)) {
      // 排除临时房（单人快开）：它不进房间列表，也不应计入大厅统计
      const summary = await MRoom.aggregate([
        { $match: { transient: { $ne: true } } },
        { $group: { _id: '$status', total: { $sum: 1 } } }]);
      const waits = summary.find(v => v._id === constant.ROOM.STATUS.waiting)?.total || 0;
      // 只有 deleted（软删/解散）的房间不算活跃。旧实现减去不存在的 'finished' 状态，
      // 导致已解散房间仍被计入"活跃房间"。
      const deletedRooms = summary.find(v => v._id === constant.ROOM.STATUS.deleted)?.total || 0;
      stats = {
        active: sumBy(summary, 'total') - deletedRooms,
        waits,
      }
      await redis.pipeline().hmset(key, stats).expire(key, config.expires).exec()
    }
    return stats;
  }
}

export const roomService = new RoomService();