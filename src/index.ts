/**
 * 游戏大厅服务器入口
 * Bun + Express + Socket.io
 *
 * 日志：`utils/logger.ts` 会在模块加载时接管全局 console，
 * 因此本文件及所有 service/handler 里的 console.log 都自动带时间戳与级别。
 * 需要新日志时用 `createLogger('scope')`，不要直接 console。
 */

// 必须第一个 import：让 console 桥接早于任何模块打日志（ESM 按声明顺序求值）
import { createLogger, flushLogs } from './utils/logger';

import express, { Express, Router, type NextFunction, type Request, type Response } from 'express';
import http from 'http';
import path from 'path';
import { Server, Socket } from 'socket.io';
import { authMiddleware, type AuthSocket } from './middleware/auth';
import { setupLobbyHandlers } from './handlers/LobbyHandler';
import { setupRoomHandlers } from './handlers/RoomHandler';
import { setupMatchingHandlers } from './handlers/MatchingHandler';
import { setupInviteHandlers } from './handlers/InviteHandler';
import { playerService } from './services/PlayerService';
import redis from './utils/redis'

import gameController from './controller/game'
import oauthController from './controller/oauth'
import userController from './controller/user'
import friendController, { setFriendIO } from './controller/friend'
import matchController from './controller/match'
import voicePackController from './controller/voicePack'
import assetsController from './controller/assets'
import adminController from './controller/admin'
import diagnosticsController from './controller/diagnostics'
import { apiNotFound, errorHandler, getHttpStats, requestLogger } from './middleware/requestLogger'
import { listMounts, listRoutes, mountRoute } from './utils/routes'
import { buildInfo } from './utils/buildInfo'
import { resolveLobbyEntry } from './utils/lobbyFallback'
import config from './config';
import { userService } from './services/UserService';
import { seedAll } from './seed';
import { timeControlService } from './services/TimeControlService';
import { snakeRuntimeService } from './services/SnakeRuntimeService';
import { roomService } from './services/RoomService';
import { matchQueue } from './services/MatchQueueService';
import { ensureRoomBots } from './services/RobotService';
import { SNAKE_ENDLESS_BOT_COUNT } from './seed.data';
import { MGame, MPlayer, MRoom } from './models';
import constant from './constant';
import { pick } from 'lodash';

const log = createLogger('boot');
const httpLog = createLogger('http');

const app: Express = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:5173', 'http://localhost:3000', '*'],
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],  // 支持两种传输方式
  pingInterval: 25000,
  pingTimeout: 60000
});

/**
 * 常驻竞技场等待队列的补位动作。
 *
 * 竞技场（贪吃蛇无尽）的桌子是**预建的官方桌**，匹配永远不新建房间：
 * 桌上有位置就直接进，没位置就排队等着 —— 有人离开腾出位置时，
 * 这里把排队的人拉进那张桌子，并通知他的前端跳过去。
 */
matchQueue.bindJoiner(async (waiter, room) => {
  const target = io.sockets.sockets.get(waiter.socket_id);
  // 等的人已经断线了：不用补，让队列里的下一位上
  if (!target) return false;
  const player = await MPlayer.findById(waiter.player_id).lean(true);
  if (!player) return false;
  const joined = await roomService.joinRoom({ room_id: room._id, type: constant.MEMBER.TYPE.player }, player as any);
  if (!joined.success) return false;
  const member = { ...player, ...joined.newPlayer };
  // 把等待者的 socket 拉进房间频道（否则收不到房间广播）
  target.room_id = room._id;
  target.player_id = player._id;
  target.join(`room:${room._id}`);
  io.to(`room:${room._id}`).emit('room:player-joined', member);
  // 竞技场进房即开局
  const match_id = await roomService.enterArena(room, {
    _id: player._id,
    nickname: player.nickname,
    skin: (player as any).skin,
  });
  if (match_id) {
    io.to(`room:${room._id}`).emit('room:game-start', { room_id: room._id, match_id, timestamp: Date.now() });
  }
  // 通知等待者「桌子找到了」，前端据此跳进房间
  const game = await MGame.findById(room.game_id, { slug: 1 }).lean(true);
  io.to(waiter.socket_id).emit('lobby:match-found', { room_id: room._id, slug: game?.slug || '' });
  console.log(`🎯 队列补位：${player.nickname || player._id} 进入竞技场 ${room._id}`);
  return true;
});

/**
 * 中间件设置
 */
// 访问日志必须最先挂：连 404 也要留痕，否则「接口不存在」无从查起
app.use(requestLogger);
app.use(express.json());
app.use(express.static('public'));

/**
 * HTTP 路由
 */
app.get('/', (req, res) => {
  res.json({
    message: '🎮 游戏大厅服务器',
    version: '1.0.0',
    websocket: `ws://localhost:${config.port}`,
    docs: '/api/docs',
    health: '/api/health'
  });
});

/**
 * 健康检查即「线上体检报告」：commit / 启动时间 / 真实注册的路由 / 近期 404。
 * 排查「接口 404 但代码里有」时，先看这里判断线上跑的是不是最新代码。
 */
const healthRouter = Router();
// 先挂载再定义 handler：这样 handler 里 listRoutes() 已经包含 GET /api/health 自己
// （express 在请求时才读 router.stack，后加路由不会失效）
mountRoute(app, '/api/health', healthRouter, 'health');
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    ...buildInfo(),
    config: {
      port: config.port,
      adminPassConfigured: Boolean(config.admin_pass || process.env.ADMIN_PASS),
    },
    routeCount: listRoutes().length,
    routes: listRoutes(),
    http: getHttpStats(),
  });
});

// 全部业务路由都经 mountRoute 登记，保证「实际挂载」与「自诊断看到的」永远一致
const ROUTES: [prefix: string, router: any, name: string][] = [
  ['/api/games', gameController, 'game'],
  ['/api/oauth', oauthController, 'oauth'],
  ['/api/users', userController, 'user'],
  ['/api/friends', friendController, 'friend'],
  ['/api/matches', matchController, 'match'],
  ['/api/voice-packs', voicePackController, 'voicePack'],
  ['/api/assets', assetsController, 'assets'],
  ['/api/admin', adminController, 'admin'],
  ['/api/debug', diagnosticsController, 'debug'],
];
for (const [prefix, router, name] of ROUTES) mountRoute(app, prefix, router, name);

// 管理端静态资源：构建产物放 server/public/admin，SPA 回退到 index.html
app.use('/admin', express.static('public/admin'))
app.get('/admin/*', (req, res) => {
  res.sendFile(path.resolve('public/admin/index.html'), err => {
    if (err) {
      httpLog.warn(`管理端未构建：${req.originalUrl}（在 admin/ 下 npm run build 后部署到 server/public/admin）`);
      res.status(404).send('管理端未构建：在 admin/ 下 npm run build 后复制到 server/public/admin');
    }
  })
})
app.post('/api/test', (req, res) => {
  httpLog.debug({ body: req.body }, 'POST /api/test')
  res.end();
  // io.to(req.body).emit('room:player-action', {})
})

/**
 * lobby 多 HTML 产物的生产环境 SPA 回退。
 *
 * 前面的 express.static('public') 已把真实存在的文件直接发出去（含 game/<slug>/assets/*），
 * 这里只会命中 HTML5 路由路径。按 URL 解析出对应入口：公共路由 → lobby/index.html，
 * 7 个白名单 slug 的游戏路由 → lobby/game/<slug>/index.html；未知 slug 交给后续路由。
 */
const lobbySpaFallback = (req: Request, res: Response, next: NextFunction) => {
  const entry = resolveLobbyEntry(req.path);
  if (!entry) return next();
  res.sendFile(path.resolve(entry), err => {
    if (err && !res.headersSent) {
      httpLog.warn(`lobby 未构建：${req.originalUrl}（缺少 ${entry}，在 lobby/ 下构建后部署到 server/public/lobby）`);
      res.status(404).send(`lobby 未构建：缺少 ${entry}，请在 lobby/ 下构建后部署到 server/public/lobby`);
    }
  });
};
// gameUrl(slug) 生成的是不带尾斜杠的 /lobby/game/<slug>，必须单独登记，
// 否则会落到下面的 /lobby/* 回退到公共入口，大厅点游戏反而回到大厅。
app.get(['/lobby', '/lobby/game/:slug'], lobbySpaFallback);
app.get('/lobby/game/:slug/*', lobbySpaFallback);
app.get('/lobby/*', lobbySpaFallback);

/**
 * Socket.io 认证中间件
 */
io.use((socket, next) => {
  authMiddleware(socket as AuthSocket, next);
});

// 好友申请的实时推送要按 player_id 反查 user_id 后定向发，controller 通过注入拿到 io（SB-061）
setFriendIO(io);

const usersMap = new Map<string, string>();
/**
 * Socket.io 连接处理
 */
io.on('connection', async (socket: AuthSocket) => {
  const user_id = socket.user_id || '';
  const wsLog = createLogger('ws');

  wsLog.info(`✅ 用户连接: ${user_id || '游客'} (${socket.id})`);
  if (user_id) {
    const socket_id = usersMap.get(user_id);
    if (socket_id) {
      const oldSocket = io.sockets.sockets.get(socket_id);
      if (oldSocket) {
        wsLog.info(`多端登录，踢掉旧连接 user=${user_id} old=${socket_id} new=${socket.id}`);
        oldSocket.emit('user:kicked', { message: '您在另一个设备登录' })
        oldSocket.disconnect(true)
      }
    }
    // 记录当前连接，供多设备登录检测使用（原实现只 get 不 set，导致检测永不触发）
    usersMap.set(user_id, socket.id);

    // 加入玩家专属的 Socket.io 房间
    socket.join(`user:${user_id}`);

    // 不能异步,不然获取用户信息超时
    const key = config.prefix + 'stats:users'
    redis.del(key);
    // 广播用户上线
    if (socket.room_id) {
      io.to(`room:${socket.room_id}`).emit('player:change', {
        player_id: socket.player_id, field: 'atline', value: true, online: true, timestamp: Date.now()
      });
    }
    io.emit('user:change', { user_id, field: 'atline', value: true, atline: true, timestamp: Date.now() });
  }

  // 注册事件处理器
  setupLobbyHandlers(io, socket, user_id);
  setupRoomHandlers(io, socket, user_id);
  // 匹配处理器内部按 (user_id, game_id) 解析 player_id，连接阶段不存在唯一 player
  setupMatchingHandlers(io, socket, user_id);
  // 房间内邀请好友（room:invite / invite:respond）
  setupInviteHandlers(io, socket, user_id);

  // 只在 LOG_LEVEL=debug 时全量打印事件名，平时零开销（不影响线上流量）
  if (wsLog.isLevelEnabled('debug')) {
    socket.onAny((event: string, ...args: unknown[]) => {
      const brief = args
        .map(a => {
          if (a === undefined || a === null) return String(a);
          if (typeof a === 'function') return 'fn';
          if (typeof a === 'object') {
            try {
              const text = JSON.stringify(a);
              return text.length > 200 ? `${text.slice(0, 200)}…` : text;
            } catch {
              return '[object]';
            }
          }
          return String(a);
        })
        .join(' ');
      wsLog.debug(`⇠ ${event} ${brief}`);
    });
  }

  /**
   * 心跳检测
   */
  socket.on('ping', (callback) => {
    wsLog.debug('ping')
    callback({ timestamp: Date.now() });
  });

  /**
   * 断开连接处理
   */
  socket.on('disconnect', async (reason) => {
    wsLog.info(`❌ 用户断开: ${user_id || '游客'} (${socket.id}) reason=${reason}`);
    // 游客没有用户身份，无需清理上线状态
    if (!user_id) return;

    // 只有在没有其它设备在线时才清理映射，避免踢掉仍在线的新连接
    const isLatest = usersMap.get(user_id) === socket.id;
    if (isLatest) {
      usersMap.delete(user_id);
    }

    const key = config.prefix + 'stats:users'
    await redis.del(key);
    await userService.getStats()
    // 广播玩家离线（payload 与前端约定：field/value 形式）
    if (socket.room_id) {
      // 直接关页面/刷新时没有"点击离开"事件：按房间里的实时对局把分数兜底记榜（$max 幂等）
      if (socket.player_id) void snakeRuntimeService.syncScoreByRoom(socket.room_id, socket.player_id);
      io.to(`room:${socket.room_id}`).emit('player:change', {
        player_id: socket.player_id, field: 'atline', value: false, online: false, timestamp: Date.now()
      });
    }
    io.emit('user:change', { user_id, field: 'atline', value: false, atline: false, timestamp: Date.now() });

    // 排队等桌的人断线了 → 从等待队列里摘掉（否则会一直占着队列位置）
    matchQueue.cancelBySocket(socket.id);

    /**
     * 人机异常掉线的额外清理。
     *
     * 人机进程崩溃（最典型：服务端快照改增量协议后，线上 robot 跑的还是旧代码，
     * 直读 `state.food` 抛 TypeError → 整个 robot 进程退出）时，它不会发
     * `lobby:leave-room`，房间里会留下一条没人操控的僵尸蛇，账号也一直被占着。
     *
     * 只在「这条连接是该账号最新的一条」时清理：多端登录踢旧连接、
     * 或 bot 重建实例时旧 socket 的断开事件晚到，都不该把新连接的成员清掉。
     */
    if (isLatest && socket.player_id && socket.room_id) {
      try {
        const player = await MPlayer.findById(socket.player_id, { type: 1 }).lean(true);
        if (player?.type === constant.PLAYER.TYPE.robot) {
          await roomService.handleRobotDisconnect(socket.room_id, socket.player_id);
        }
      } catch (error) {
        console.error('❌ 人机掉线清理失败:', error);
      }
    }
  });
});

/**
 * 兜底路由：
 * - `/api/*` 未匹配 → JSON（前端能读到 message/hint，而不是「页面不存在」纯文本）
 * - 其余 → 原行为
 */
app.use('/api', apiNotFound);
app.use((req, res) => {
  if (req.path.startsWith('/lobby')) {
    res.redirect('/lobby');
  } else {
    res.status(404).end('页面不存在')
  }
});

// 必须最后挂：Express 四参错误中间件
app.use(errorHandler);

/**
 * 启动服务器
 */
server.listen(config.port, async () => {
  // 确保 games 有基础游戏、players 有机器人账号，否则列表 loading / 添加机器人失败
  try {
    await seedAll();
  } catch (error) {
    console.error('❌ 种子数据初始化失败（服务继续启动）:', error);
  }
  // 启动计时巡检器：启用计时的对局由服务端权威判负（含玩家挂机不落子的场景）
  timeControlService.start(io, 1000);

  // 修复历史遗留的悬空 room_id（房间已删但玩家还指着它 → 前端进游戏会跳到不存在的房间）
  try {
    await playerService.repairDanglingRooms();
  } catch (error) {
    console.error('❌ 悬空 room_id 清理失败（服务继续启动）:', error);
  }

  // 清理重复 / 孤儿玩家记录：
  // 同一 (user_id, game_id) 有多条 player 时，getOrCreatePlayer 取到哪条是随机的，
  // 拿到挂着旧 room_id 的那条就会"进游戏被弹回旧房间、反复弹已离开房间"。
  try {
    await playerService.dedupePlayers();
  } catch (error) {
    console.error('❌ 重复玩家记录清理失败（服务继续启动）:', error);
  }
  try {
    await playerService.removeOrphanPlayers();
  } catch (error) {
    console.error('❌ 孤儿玩家记录清理失败（服务继续启动）:', error);
  }
  // 清理僵尸对局 / 僵尸房间（房间停在 playing 但对局已不存在）
  try {
    await playerService.cleanupZombieMatches();
  } catch (error) {
    console.error('❌ 僵尸对局清理失败（服务继续启动）:', error);
  }

  // 贪吃蛇运行时：服务端权威 tick。结算走 roomService.gameover（分榜 endless/team，按单局最高分）
  snakeRuntimeService.start(io, async ({ room_id, match_id, winner, scores, variant }) => {
    const board = variant === 'endless' ? 'endless' : 'team';
    // 两种玩法都按"该玩法最高分"记录（无尽跨重生、多人单局），不累加
    await roomService.gameover(room_id, match_id, winner, scores, 'max', board);
    if (variant === 'team') {
      const winnerPlayer = winner ? await MPlayer.findById(winner).lean(true) : null;
      io.to(`room:${room_id}`).emit('room:game-over', winner
        ? { ...pick(winnerPlayer || {}, ['_id', 'nickname']), scores }
        : { _id: '', nickname: '', draw: true, scores });
    }
    console.log(`🐍 贪吃蛇 ${variant} 结束 match=${match_id} winner=${winner || '—'}`);
  });
  // 重启后回收中断的多人对局（否则房间会永远停在 playing）
  await snakeRuntimeService.resetStaleMatches();

  // 给第一个官方无尽桌补 2 个人机（幂等：已有就只补差量）。
  // **只有第一个无尽桌有人机**：其余官方桌保持空桌，玩家进去自己开局。
  // robot 服务没起来时静默跳过，不能拖慢/阻塞服务启动。
  try {
    const [endlessRoom] = await MRoom.find({
      game_id: 'snake',
      'settings.variant': 'endless',
      status: { $ne: constant.ROOM.STATUS.deleted },
    }).sort({ createdAt: 1 }).limit(1).lean(true);
    if (endlessRoom) {
      await ensureRoomBots(endlessRoom._id, SNAKE_ENDLESS_BOT_COUNT);
    }
  } catch (error) {
    console.error('❌ 无尽桌补人机失败（服务继续启动）:', error);
  }

  const info = buildInfo();
  log.info(`🚀 游戏大厅服务器启动成功  commit=${info.commit} env=${info.env} pid=${info.pid}`);
  log.info(`📍 http://localhost:${config.port}  ·  🔌 ws://localhost:${config.port}`);
  log.info(`📊 健康检查（含路由表/近期 404）: http://localhost:${config.port}/api/health`);
  log.info(`🧾 已挂载 ${listRoutes().length} 条路由：${listMounts().map(m => `${m.prefix}(${m.count})`).join('  ')}`);
  log.info(`🧪 诊断: /api/debug/routes · /api/debug/logs?token=admin_pass · /api/debug/config?token=admin_pass`);
  log.info(`🎚 日志级别: LOG_LEVEL=${process.env.LOG_LEVEL || 'info'}${process.env.LOG_PRETTY ? ` · LOG_PRETTY=${process.env.LOG_PRETTY}` : ''}`);
  if (!config.admin_pass && !process.env.ADMIN_PASS) {
    log.warn('⚠️ 未配置 admin_pass：管理端（/api/admin/login）会拒绝登录，诊断端点也保持关闭');
  }
});

/**
 * 启动失败要说得清楚：EADDRINUSE 是最常见的"改了代码不生效"原因（旧进程还占着端口）
 */
server.on('error', (error: any) => {
  if (error?.code === 'EADDRINUSE') {
    log.error(`端口 ${config.port} 已被占用 —— 旧进程还在跑，请求会继续打到旧代码上。先 kill 旧进程再启动`);
  } else if (error?.code === 'EACCES') {
    log.error(`端口 ${config.port} 无权限监听（<1024 需要特权）`);
  } else {
    log.error('HTTP server 启动失败', error);
  }
  flushLogs();
  process.exit(1);
});

/**
 * 进程级兜底：不能让异常只留一堆乱码，必须带堆栈进日志
 */
process.on('uncaughtException', error => {
  log.error('未捕获异常，进程退出', error);
  flushLogs();
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  log.error('未处理的 Promise 拒绝（进程继续运行）', reason);
});

/**
 * 优雅关闭
 */
const shutdown = (signal: string) => {
  log.info(`🛑 收到 ${signal}，服务器关闭中...`);
  server.close(() => {
    log.info('✅ 服务器已关闭');
    flushLogs();
    process.exit(0);
  });
  // 有长连接（Socket.io）时 close 可能迟迟不回调，兜底强制退出
  setTimeout(() => {
    log.warn('⚠️ 关闭超时，强制退出');
    flushLogs();
    process.exit(0);
  }, 5000).unref?.();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;