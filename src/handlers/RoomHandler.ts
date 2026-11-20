/**
 * 房间事件处理
 */

import type { Server } from 'socket.io';
import { CB } from '../types';
import { roomService } from '../services/RoomService';
import { snakeRuntimeService } from '../services/SnakeRuntimeService';
import type { AuthSocket } from '../middleware/auth';
import constant from '../constant'
import { MGame, MMatch, MPlayer, MRoom, MUser } from '../models';
import GameLogics from '../games'
import { gameService } from '../services/GameService';
import { pick } from 'lodash';
import config from '../config';
import { TicketTool } from '../utils';
import { settleMove, findTimeout, clockSnapshot, normalizeTimeControl, type MatchTimeControl } from '../utils/timeControl';
import { canDisbandRoom, canStartGame, canUpdateSettings } from '../utils/roomPolicy';
import _ from 'lodash';

const ticketHelper = new TicketTool(config.secret);

export function setupRoomHandlers(io: Server, socket: AuthSocket, user_id: string) {
  const isLoggedIn = socket.isLoggedIn;

  socket.on('room:detail', getRoomDetail);
  socket.on('room:update-settings', updateRoom);
  socket.on('room:update-timecontrol', updateTimeControl);
  socket.on('room:send-message', sendMessage);
  socket.on('room:kick-player', kickPlayer);
  socket.on('room:transferor-owner', transferOwner);
  socket.on('room:add-robot', addRobot,);
  socket.on('room:leave', leaveRoom);
  socket.on('room:player-ready', playerReadyChange)
  socket.on('room:player-action', playerAction)
  socket.on('room:start-game', startGame);
  socket.on('room:get-match-state', getMatchState);
  socket.on('room:player-surrender', surrender);
  socket.on('room:disband', closeRoom)
  socket.on('room:sync-score', syncScore)

  /**
   * 点击离开/关闭时同步分数：客户端只带 room_id + player_id（不带分数，防篡改），
   * 服务端按正在跑的实时对局取分并 $max 写榜。与瞄准/加速上报走不同通道，
   * 网络慢时也不会因为这条消息没到就丢分 —— leave 与 disconnect 还会各兜一次。
   */
  async function syncScore(
    data: { room_id: string; player_id: string },
    callback?: (ok: boolean) => void,
  ) {
    if (!isLoggedIn || !data?.room_id || !data?.player_id) {
      callback?.(false);
      return;
    }
    try {
      // 只认当前登录用户名下的玩家，防止替别人刷榜
      const own = await MPlayer.exists({ _id: data.player_id, user_id });
      if (!own) { callback?.(false); return; }
      const ok = await snakeRuntimeService.syncScoreByRoom(data.room_id, data.player_id);
      callback?.(ok);
    } catch (error) {
      console.log('❌ 同步贪吃蛇分数失败:', error);
      callback?.(false);
    }
  }

  async function getRoomDetail(data: { room_id: string }, cb: CB) {
    // 游客只能浏览大厅，房间详情属于对局内容，需要先登录
    if (!isLoggedIn) {
      cb({ room: null, match_id: '' });
      return;
    }
    const { room_id } = data;
    // 自愈：清悬空成员（玩家记录已删 → 玩家列表出现空白名字）、修"playing 但没有对局"的幽灵房。
    // 不做这一步的话，玩家会进到渲染了画布却永远收不到快照的房间（一直"连接中"）。
    const room = await roomService.reconcileRoom(room_id);
    let match_id = '';
    if (room) {
      const members = await MPlayer.find({ _id: { $in: room.members.map((m: any) => m._id) } }).lean(true)
      room.members = room.members.map((m: any) => {
        const player = members.find(p => p._id === m._id)
        return { ...player, ...m }
      });
    }
    if (room && room.status === constant.ROOM.STATUS.playing) {
      const match = await MMatch.findOne({ room_id, status: constant.MATCH.STATUS.playing }, { _id: 1 }).lean();
      match_id = match ? match._id : ''
    }
    // 贪吃蛇：保证服务端 tick 在跑（重启后按库里局面重建运行时；无尽房回房/刷新时补开局）
    if (room) {
      const arena = await roomService.ensureSnakeArena(room_id);
      if (arena.started) {
        io.to(`room:${room_id}`).emit('room:game-start', { room_id, match_id: arena.match_id, timestamp: Date.now() });
      }
      if (arena.match_id) {
        match_id = arena.match_id;
        room.status = constant.ROOM.STATUS.playing;
      }
    }
    cb({ room, match_id })
  }
  /**
   * 发送房间消息
   * @description 判断条件是否满足,向房间发送消息同步数据
   */
  async function sendMessage(data: { room_id: string; message: string }, callback: (success: boolean) => void) {
    console.log(`玩家发言 ${data.room_id} ${data.message}`)
    if (!socket.isLoggedIn) {
      callback(false);
      return;
    }

    const { room_id, message } = data;
    const room = await roomService.getRoomById(room_id);
    if (!room || !message) {
      callback(false);
      return;
    }
    const player = await MPlayer.findOne({ user_id, game_id: room.game_id }).lean(true)

    if (!player) {
      callback(false);
      return;
    }
    callback(true);

    console.log('广播')
    io.to(`room:${room_id}`).emit('room:message', {
      player_id: player._id,
      player_name: player.nickname,
      message,
      timestamp: Date.now()
    });

  }
  /**
   * 房主开始游戏
   * @description 判断条件是否满足,修改房间状态,分配位置,向房间发送通知(初始状态数据和玩家分配信息)
   */
  async function startGame(data: { room_id: string, player_id: string }, callback: (success: boolean, message?: string) => void) {
    if (!socket.isLoggedIn) {
      return callback(false, '请先登录');
    }

    const { room_id } = data;
    const room = await roomService.getRoomById(room_id);
    if (!room) {
      return callback(false, '房间不存在');
    }
    // 仅房间内对战玩家、房主可开局（官方房房主为第一位入座玩家）
    const me = await MPlayer.findOne({ user_id: socket.user_id, game_id: room.game_id }).lean(true);
    const check = canStartGame(room, me?._id || '');
    if (!check.ok) {
      return callback(false, check.reason);
    }
    try {
      const match_id = await roomService.startGame(room_id);
      if (!match_id) {
        return callback(false, '开局失败');
      }

      callback(true);
      const now = Date.now();
      const startPayload = { room_id, match_id, timestamp: now };
      io.to(`room:${room_id}`).emit('room:game-start', startPayload);

      // 若该对局启用了计时，向房间广播初始时钟快照，前端据此渲染倒计时。
      const startedMatch = await MMatch.findById(match_id).lean(true);
      if (startedMatch?.curr_state?.timeControl?.enabled) {
        io.to(`room:${room_id}`).emit('room:clock', clockSnapshot(
          match_id,
          startedMatch.curr_state.timeControl as MatchTimeControl,
          startedMatch.curr_state.curr_turn,
          now,
        ));
      }

      // 实时多人游戏（贪吃蛇多人模式）：启动服务端权威 tick 循环
      const startedGame = await MGame.findById(room.game_id, { slug: 1 }).lean(true);
      const variant = room.settings?.variant as string | undefined;
      if (startedMatch && startedGame && GameLogics[startedGame.slug]?.isRealtimeVariant?.(variant)) {
        snakeRuntimeService.spawn(startedMatch as any);
      }

      // 机器人 socket 可能还在连接中、尚未加入 room 频道，会漏掉上面的广播。
      // 机器人账号在连接建立时就加入了 user:${user_id} 频道（见 index.ts），
      // 因此向其专属频道补发一次，保证开局通知可靠送达。
      const robotIds = room.members
        .filter(m => m.player_type === constant.PLAYER.TYPE.robot)
        .map(m => m._id);
      if (robotIds.length) {
        const robots = await MPlayer.find({ _id: { $in: robotIds } }, { user_id: 1 }).lean(true);
        robots.forEach(r => io.to(`user:${r.user_id}`).emit('room:game-start', startPayload));
      }
    } catch (error) {
      console.log(error)
      callback(false);
    }
  }

  async function getMatchState(data: { game_slug: string, match_id: string }, callback: (state: any) => void) {
    const result = await gameService.getMatchState(data.game_slug, data.match_id)
    callback(result);
  }

  /**
   * 房主踢出玩家
   */
  async function kickPlayer(data: { room_id: string; player_id: string }, callback: (success: boolean) => void) {
    const user_id = socket.user_id || '';
    if (!socket.isLoggedIn || !user_id) {
      callback(false);
      return;
    }

    const { room_id, player_id } = data;
    try {
      const success = await roomService.kickPlayer(room_id, player_id);

      if (!success) {
        callback(false);
        return;
      }
      callback(true);

      // 通知房间内其他玩家
      io.to(`room:${room_id}`).emit('room:player-kicked', { player_id });
      console.log(`👢 玩家 ${player_id} 被从房间 ${room_id} 踢出`);
    } catch (error) {
      console.log(error)
      callback(false);
    }
  }
  /**
   * 转让房主
   */
  async function transferOwner(data: { room_id: string; player_id: string }, callback: (success: boolean) => void) {
    const user_id = socket.user_id || '';
    if (!socket.isLoggedIn || !user_id) {
      callback(false);
      return;
    }

    const { room_id, player_id } = data;
    try {
      const success = await roomService.transferOwner(room_id, player_id);
      if (!success) {
        return callback(false);
      }
      callback(true);
      io.to(`room:${room_id}`).emit('room:transferee-owner', { player_id });
      console.log(`房间 ${room_id} 被转让给 ${player_id}`)
    } catch (error) {
      callback(false)
    }
  }
  async function addRobot(data: { room_id: string; }, callback: (success: boolean, message?: string) => void) {
    const room = await MRoom.findById(data.room_id).lean(true);
    if (!room) return callback(false, '房间不存在');

    const game = await MGame.findById(room.game_id, { slug: 1 }).lean(true);
    if (!game) return callback(false, '游戏不存在');

    // 限制每个房间的机器人数量（固定房模式，避免机器人无限堆叠）
    const robotCount = room.members.filter(m => m.player_type === constant.PLAYER.TYPE.robot).length;
    if (robotCount >= config.max_robot_per_room) {
      return callback(false, '本房间机器人数量已达上限');
    }

    // 原子占用一个在线机器人（state online -> matching），防止并发重复分配同一个账号。
    // 只有种子数据里 type=robot/state=online 的账号会被选中。
    const claimed = await MPlayer.findOneAndUpdate(
      { game_id: room.game_id, type: constant.PLAYER.TYPE.robot, state: constant.PLAYER.STATE.online },
      { $set: { state: constant.PLAYER.STATE.matching, updatedAt: new Date() } },
      { sort: { level: -1 }, new: true }
    ).lean(true);
    if (!claimed) return callback(false, '暂无空闲机器人');

    const user = await MUser.findById(claimed.user_id).lean(true);
    if (!user) {
      await releaseClaim(claimed._id);
      return callback(false, '机器人账号异常');
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
          room_id: data.room_id,
        }),
      });
      const body = await resp.json().catch(() => null);
      if (!resp.ok || body?.code !== 0) {
        await rollback();
        return callback(false, '机器人服务不可用');
      }
      // 机器人服务已接受，bot 会带着 ticket 自行 join-room（joinRoom 会把 state 置为 inroom）
      callback(true);
    } catch (error) {
      console.error('❌ 添加机器人失败:', error);
      await rollback();
      callback(false, '机器人服务不可用');
    }
  }

  async function releaseClaim(player_id: string) {
    await MPlayer.updateOne({ _id: player_id }, { $set: { state: constant.PLAYER.STATE.online, room_id: '' } });
  }

  /**
   * 玩家切换准备状态
   * @description 玩家改变自己的状态(只能是非游戏时),准备/取消准备.返回 success 表示是否改变成功.通知房间 roomReady 表示是否所有人已准备(以便房主开始游戏)
   */
  async function playerReadyChange(data: { room_id: string; player_id: string; ready: boolean }, callback: (success: boolean) => void) {
    const user_id = socket.user_id || '';
    if (!socket.isLoggedIn || !user_id) {
      callback(false);
      return;
    }

    const { room_id, ready } = data;
    const room = await roomService.getRoomById(room_id);

    if (!room) {
      callback(false);
      return;
    }

    try {
      const room = await MRoom.findById(room_id).lean(true);
      if (!room || room.status === constant.ROOM.STATUS.playing) {
        return callback(false);
      }
      const success = await roomService.playerReady(room, ready, data.player_id);
      callback(success);
      // 只广播就绪状态，不自动开局。所有玩家进房自动 prepared，开局一律由房主显式点"开始游戏"控制。
      const roomReady = await roomService.roomReady(room)
      io.to(`room:${room_id}`).emit('room:room-ready', roomReady)
      console.log(`🏠 房间 ${room_id} ${roomReady ? "已就绪" : "未就绪"}`);
    } catch (error) {
      callback(false);
    }
  }
  async function playerAction(match_id: string, movement: { player_id: string, [key: string]: any }, callback?: (result: { success: boolean; message: string }) => void) {
    // 实时游戏（多人贪吃蛇）的转向指令可以不带 ack；这里统一兜底，避免 callback 未定义时崩溃
    const reply = typeof callback === 'function' ? callback : () => { };
    const player = await MPlayer.findById(movement.player_id);
    if (!player || player.user_id !== user_id) {
      return reply({ success: false, message: '玩家不存在' });
    }
    const match = await MMatch.findOne({ _id: match_id }).lean(true);
    if (match) {
      const game = await MGame.findById(match.game_id).lean(true);
      if (!game) return reply({ success: false, message: '游戏不存在' })

      // 权威计时：落子前先按服务器时间结算本回合耗时。
      // 若落子方思考时间已把总额度耗尽，拒绝本次落子并判其超时负。
      const now = Date.now();
      const tcRaw = match.curr_state?.timeControl as MatchTimeControl | undefined;
      if (tcRaw?.enabled) {
        const currTurn = match.curr_state?.curr_turn;
        const timeoutLoser = findTimeout(tcRaw, currTurn, now);
        if (timeoutLoser) {
          const winner = match.players.find(p => p._id !== timeoutLoser);
          reply({ success: false, message: '思考超时' });
          await roomService.gameover(match.room_id, match_id, winner?._id as string);
          const winnerPlayer = winner && await MPlayer.findById(winner._id).lean(true);
          io.to(`room:${match.room_id}`).emit('room:game-over', {
            ...pick(winnerPlayer || {}, ['_id', 'nickname']), reason: 'timeout'
          });
          return;
        }
      }

      const { success, gameover, data } = await GameLogics[game.slug].excuteMove(match, movement)
      reply({ success, message: '' });
      if (success) {
        // 实时游戏（多人贪吃蛇）的转向指令：由运行时 tick 统一广播快照，这里不回播
        if (data?.silent) return;
        // 单人游戏进度上报（2048/贪吃蛇无尽等）：只更新玩家最高分，不广播、不结算。
        if (data?.progress) {
          const isRecord = await roomService.recordSoloScore(movement.player_id, data.score, data.board);
          if (isRecord) console.log(`📊 刷新最高分 player=${movement.player_id} board=${data.board || '-'} score=${data.score}`);
          return;
        }
        io.to(`room:${match.room_id}`).emit('room:player-action', data);

        // 落子成功后结算本回合计时：超时部分从落子方总额度扣除，重置下一回合起始时间。
        let tc = tcRaw;
        if (tc?.enabled) {
          const next = match.players.find(p => p._id !== movement.player_id);
          const settled = settleMove(tc, movement.player_id, next?._id, Date.now());
          tc = settled.state;
          await MMatch.updateOne({ _id: match_id }, { $set: { 'curr_state.timeControl': tc } });
          io.to(`room:${match.room_id}`).emit('room:clock', clockSnapshot(
            match_id, tc, data?.next_turn || next?._id || '', Date.now()
          ));
        }

        if (gameover) {
          // 胜者由游戏逻辑在 data.winner 中指定（如黑白棋按子数、国际象棋逼和为平局）。
          // 缺省回退到落子方，保持象棋/五子棋行为不变；winner === '' 表示平局。
          const winnerId: string = data?.winner !== undefined ? data.winner : movement.player_id;
          // data.scores：单人游戏上报的本局分数表 / 多人贪吃蛇的分数表；
          // scoreMode='max' 表示按该玩法最高分记入榜单（而非累加）；
          // data.board：分榜 key（贪吃蛇 endless/multi）。
          await roomService.gameover(match.room_id, match_id, winnerId, data?.scores, data?.scoreMode, data?.board)
          // data.score：本局得分，随结算广播下发给前端展示（对战游戏无此字段）。
          const scoreField = data?.score !== undefined ? { score: data.score, solo: !!data?.solo } : {};
          if (winnerId) {
            const winnerPlayer = winnerId === movement.player_id
              ? player
              : await MPlayer.findById(winnerId).lean(true);
            io.to(`room:${match.room_id}`).emit('room:game-over', { ...pick(winnerPlayer || {}, ['_id', 'nickname']), ...scoreField })
          } else {
            io.to(`room:${match.room_id}`).emit('room:game-over', { _id: '', nickname: '', draw: true, ...scoreField })
          }
        } else if (tc?.enabled) {
          // 结算后落子方额度可能刚好归零：本步已落下，下一回合其回合开始时判负。
          // 交由统一超时巡检器处理，避免此处与 gameover 重复结算。
        }
      }
    } else {
      reply({ success: false, message: '对局不存在' })
    }

  }
  /**
   * 更新房间设置（含观战开关）。
   * - 仅房主可改（官方房房主为第一位入座玩家）
   * - allowSpectate 仅等待态可切换，开局后沿用当前设置
   */
  async function updateRoom(
    data: { room_id: string; settings?: Record<string, any>; allowSpectate?: boolean },
    callback: (success: boolean, message?: string) => void,
  ) {
    if (!socket.isLoggedIn) {
      callback(false, '请先登录');
      return;
    }

    const { room_id, settings, allowSpectate } = data;
    const room = await roomService.getRoomById(room_id);

    // owner_id 统一为 player._id；用当前 user 在该游戏的 player 来判定房主
    const ownerPlayer = room && await MPlayer.findOne({ user_id: socket.user_id, game_id: room.game_id }).lean(true);
    const check = room && canUpdateSettings(room, ownerPlayer?._id || '');
    if (!room || !check?.ok) {
      callback(false, check?.reason || '无权修改房间设置');
      return;
    }

    try {
      const set: Record<string, any> = { updatedAt: new Date() };
      if (settings) {
        // 必须落库，否则刷新即丢失
        set.settings = { ...(room.settings || {}), ...settings };
      }
      // 观战开关：仅等待态可切换
      if (typeof allowSpectate === 'boolean') {
        if (room.status !== constant.ROOM.STATUS.waiting) {
          return callback(false, '对局已开始，无法修改观战设置');
        }
        set.allowSpectate = allowSpectate;
      }
      await MRoom.updateOne({ _id: room_id }, { $set: set });

      io.to(`room:${room_id}`).emit('room:settings-updated', {
        settings: set.settings || room.settings || {},
        ...(typeof allowSpectate === 'boolean' ? { allowSpectate } : {}),
      });

      callback(true);
    } catch (error) {
      callback(false, '保存失败');
    }
  }
  /**
   * 更新象棋房间计时配置（读秒制）。
   * 开局前房间内任一对战玩家（双方）均可修改；开局后对局使用开局时的快照，改动不再影响当前对局。
   */
  async function updateTimeControl(
    data: { room_id: string; timeControl: { enabled: boolean; stepLimitSec: number; totalBudgetMin: number } },
    callback: (success: boolean, message?: string) => void,
  ) {
    if (!socket.isLoggedIn) return callback(false, '请先登录');
    const room = await roomService.getRoomById(data.room_id);
    if (!room) return callback(false, '房间不存在');
    if (room.status !== constant.ROOM.STATUS.waiting) return callback(false, '对局已开始，无法修改计时');

    // 仅象棋可配置计时
    const game = await MGame.findById(room.game_id, { slug: 1 }).lean(true);
    if (!game || game.slug !== 'xiangqi') return callback(false, '该游戏不支持计时配置');

    // 双方（房间内任一 player 成员）均可配置；观战者不可
    const me = await MPlayer.findOne({ user_id: socket.user_id, game_id: room.game_id }).lean(true);
    const isMember = me && room.members.some(m =>
      m._id === me._id && m.member_type === constant.MEMBER.TYPE.player);
    if (!isMember) return callback(false, '只有对战玩家可以设置计时');

    try {
      const tc = normalizeTimeControl(data.timeControl);
      const settings = { ...(room.settings || {}), timeControl: tc };
      await MRoom.updateOne({ _id: data.room_id }, { $set: { settings, updatedAt: new Date() } });
      io.to(`room:${data.room_id}`).emit('room:timecontrol-updated', { timeControl: tc });
      callback(true);
    } catch (error) {
      callback(false, '保存失败');
    }
  }

  /**
   * 认输
   * @description 修改房间状态为 waiting,非房主状态为 idle,对局match结束,向房间所有人发送消息和 room 最新数据
   */
  async function surrender(data: { room_id: string; match_id: string, player_id: string }, callback: (success: boolean) => void) {
    const room = await roomService.getRoomById(data.room_id);
    if (!room || room.status !== constant.ROOM.STATUS.playing) {
      callback(false);
      return;
    }
    const player = await MPlayer.findById(data.player_id).lean(true);
    if (!player || player.user_id !== user_id) {
      callback(false);
      return;
    }
    try {
      callback(true);
      console.log(`🏡 ${room._id} 👤 玩家 ${player._id} 认输`);

      // 实时多人（贪吃蛇）：认输 = 自我淘汰，对局继续推进，由运行时判出最后存活者
      const match = await MMatch.findById(data.match_id).lean(true);
      const matchGame = match && await MGame.findById(match.game_id, { slug: 1 }).lean(true);
      if (matchGame?.slug === 'snake' && match?.curr_state?.variant === 'multi') {
        const ok = snakeRuntimeService.eliminate(data.match_id, data.player_id);
        io.to(`room:${data.room_id}`).emit('room:message', {
          player_id: player._id,
          player_name: player.nickname || '玩家',
          message: '认输退出本局',
          timestamp: Date.now(),
        });
        if (!ok) console.log(`⚠️ 贪吃蛇认输未能定位蛇: match=${data.match_id} player=${data.player_id}`);
        return;
      }

      const winner_id = room.members.filter(m => m.member_type === constant.MEMBER.TYPE.player).map(m => m._id).find(_id => _id !== data.player_id)
      await roomService.gameover(data.room_id, data.match_id, winner_id as string)
      // 其他实时对局兜底：结算后停掉 tick，避免继续推进并二次结算
      snakeRuntimeService.stop(data.match_id);
      const winner = await MPlayer.findById(winner_id).lean(true)
      io.to(`room:${data.room_id}`).emit('room:game-over', pick(winner, ['_id', 'nickname']))
    } catch (error) {
      console.log(error, 'err')
      callback(false);
    }
  }

  /**
   * 离开房间
   * @description 判断玩家是不是房间中的人,离开操作 从房间中去掉该玩家,并重置游戏玩家的当前房间.向房间发送消息
   */
  async function leaveRoom(data: { room_id: string; player_id: string }, callback?: (success: boolean, message?: string) => void) {
    // callback 是可选的（客户端可能只发不带 ack 的 leave）；缺了也不能抛错拖垮进程
    if (!data?.room_id || !data?.player_id) {
      callback?.(false, '参数错误');
      return;
    }
    if (!isLoggedIn) {
      callback?.(false, '请先登录');
      return;
    }

    try {
      const result = await roomService.leaveRoom(data.room_id, data.player_id);
      if (!result.ok) {
        callback?.(false, result.reason);
        return;
      }
      callback?.(true, result.dissolved ? '房间已解散' : '已离开房间');

      socket.room_id = undefined;
      socket.leave(`room:${data.room_id}`);
      socket.leave(`user:${user_id}`);
      if (result.dissolved) {
        // 房主离开即解散房间，通知房间内其他人
        io.to(`room:${data.room_id}`).emit('lobby:room-destroyed', {});
        console.log(`🏠 房主 ${data.player_id} 离开，房间 ${data.room_id} 已解散`);
      } else {
        const player = await MPlayer.findById(data.player_id).lean(true)
        io.to(`room:${data.room_id}`).emit('room:player-leaved', pick(player, ['_id', 'nickname']));
        console.log(`👤 玩家 ${data.player_id} 离开房间 ${data.room_id}`);
      }
    } catch (error) {
      console.log(error, 'err')
      callback?.(false, '离开失败');
    }
  }

  /**
   * 解散房间。
   * 仅自建房的房主可解散；官方公共房不能解散（只能退出），单人快开房由离开即销毁。
   */
  async function closeRoom(data: { room_id: string }, cb: (success: boolean, message?: string) => void) {
    if (!isLoggedIn) {
      return cb(false, '请先登录');
    }
    const room = await roomService.getRoomById(data.room_id);
    if (!room) {
      return cb(false, '房间不存在');
    }
    // 仅房主（自建房创建者/持有者）可解散；官方房直接拒绝
    const me = await MPlayer.findOne({ user_id: socket.user_id, game_id: room.game_id }).lean(true);
    const check = canDisbandRoom(room, me?._id || '');
    if (!check.ok) {
      return cb(false, check.reason);
    }
    const destroyed = await roomService.destroyRoom(data.room_id);
    if (destroyed) {
      // 操作者先退出频道（避免广播+ack 双重处理），再通知房间内其他人
      socket.leave(`room:${room._id}`);
      io.to(`room:${room._id}`).emit('lobby:room-destroyed', {});
      cb(true);
    } else {
      cb(false, '解散失败');
    }
  }
}