/**
 * 游戏大厅服务器入口
 * Bun + Express + Socket.io
 */

import express, { Express } from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { authMiddleware, type AuthSocket } from './middleware/auth';
import { setupLobbyHandlers } from './handlers/LobbyHandler';
import { setupRoomHandlers } from './handlers/RoomHandler';
import { setupMatchingHandlers } from './handlers/MatchingHandler';
import { playerService } from './services/PlayerService';
import redis from './utils/redis'

import gameController from './controller/game'
import oauthController from './controller/oauth'
import config from './config';
import { userService } from './services/UserService';
import { seedAll } from './seed';
import { timeControlService } from './services/TimeControlService';

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

const PORT = process.env.PORT || 3000;

/**
 * 中间件设置
 */
app.use(express.json());
app.use(express.static('public'));

/**
 * HTTP 路由
 */
app.get('/', (req, res) => {
  res.json({
    message: '🎮 游戏大厅服务器',
    version: '1.0.0',
    websocket: `ws://localhost:${PORT}`,
    docs: '/api/docs'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now()
  });
});

app.use('/api/games', gameController)
app.use('/api/oauth', oauthController)
app.post('/api/test', (req, res) => {
  console.log(req.body, typeof req.body)
  res.end();
  // io.to(req.body).emit('room:player-action', {})
})

/**
 * Socket.io 认证中间件
 */
io.use((socket, next) => {
  authMiddleware(socket as AuthSocket, next);
});

const usersMap = new Map<string, string>();
/**
 * Socket.io 连接处理
 */
io.on('connection', async (socket: AuthSocket) => {
  const user_id = socket.user_id!;

  console.log(`\n✅ 用户连接: ${user_id} (${socket.id})`);
  const socket_id = usersMap.get(user_id);
  if (socket_id) {
    const oldSocket = io.sockets.sockets.get(socket_id);
    if (oldSocket) {
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

  // 注册事件处理器
  setupLobbyHandlers(io, socket, user_id);
  setupRoomHandlers(io, socket, user_id);
  // 匹配处理器内部按 (user_id, game_id) 解析 player_id，连接阶段不存在唯一 player
  setupMatchingHandlers(io, socket, user_id);

  /**
   * 心跳检测
   */
  socket.on('ping', (callback) => {
    console.log('ping')
    callback({ timestamp: Date.now() });
  });

  /**
   * 断开连接处理
   */
  socket.on('disconnect', async (reason) => {
    console.log(reason)
    // 只有在没有其它设备在线时才清理映射，避免踢掉仍在线的新连接
    if (usersMap.get(user_id) === socket.id) {
      usersMap.delete(user_id);
    }

    const key = config.prefix + 'stats:users'
    await redis.del(key);
    await userService.getStats()
    // 广播玩家离线（payload 与前端约定：field/value 形式）
    if (socket.room_id) {
      io.to(`room:${socket.room_id}`).emit('player:change', {
        player_id: socket.player_id, field: 'atline', value: false, online: false, timestamp: Date.now()
      });
    }
    io.emit('user:change', { user_id, field: 'atline', value: false, atline: false, timestamp: Date.now() });

    console.log(`❌ 用户断开: ${user_id} (${socket.id})\n`);
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/lobby')) {
    res.redirect('/lobby');
  } else {
    res.status(404).end('页面不存在')
  }
});

/**
 * 启动服务器
 */
server.listen(PORT, async () => {
  // 确保 games 有基础游戏、players 有机器人账号，否则列表 loading / 添加机器人失败
  try {
    await seedAll();
  } catch (error) {
    console.error('❌ 种子数据初始化失败（服务继续启动）:', error);
  }
  // 启动计时巡检器：启用计时的对局由服务端权威判负（含玩家挂机不落子的场景）
  timeControlService.start(io, 1000);
  console.log(`\n🚀 游戏大厅服务器启动成功!`);
  console.log(`📍 地址: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`📊 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`📈 统计信息: http://localhost:${PORT}/api/stats\n`);
});

/**
 * 优雅关闭
 */
process.on('SIGINT', () => {
  console.log('\n🛑 服务器关闭中...');
  server.close(() => {
    console.log('✅ 服务器已关闭');
    process.exit(0);
  });
});

export default app;