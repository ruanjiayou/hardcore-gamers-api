/**
 * 认证中间件 - 支持登陆用户和游客
 */

import type { Socket } from 'socket.io';
import ioredis from 'ioredis'
import jwt from 'jsonwebtoken'
import { userService } from '../services/UserService';
import redis from '../utils/redis'
import { MPlayer } from '../models';
import config from '../config';
import { TicketTool } from '../utils';

const ticketHelper = new TicketTool(config.secret);

export interface AuthSocket extends Socket {
  user_id?: string;
  player_id?: string;
  room_id?: string;
  isLoggedIn?: boolean;
  isGuest?: boolean;
  redis?: ioredis
}

/**
 * 验证用户名和密码
 */
export function validateCredentials(username: string, password: string): boolean {
  // TODO: verify
  return false;
}

/**
 * Socket.io 认证中间件
 */
export async function authMiddleware(socket: AuthSocket, next: (err?: Error) => void) {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  const ticket = socket.handshake.auth.ticket || socket.handshake.query.ticket;
  let user_id = socket.handshake.auth.user_id || socket.handshake.query.user_id || '';
  if (token) {
    try {
      const data: any = jwt.verify(token, config.secret)
      user_id = data._id;
      socket.isLoggedIn = true;
      socket.isGuest = false;
    } catch (err) {
      return next(new Error('账号已过期'))
    }
  } else if (ticket) {
    try {
      const data = JSON.parse(ticketHelper.decrypt(ticket));
      user_id = data.user_id;
      socket.isLoggedIn = true;
      socket.isGuest = false;
    } catch (err) {
      return next(new Error('票据错误'))
    }
  } else if (user_id) {
    socket.isGuest = true;
    socket.isLoggedIn = true;
  } else {
    return next(new Error('请登陆'))
  }
  // 获取或创建玩家
  const user = await userService.getInfoById(user_id);
  if (!user) {
    return next(new Error('验证失败'))
  }
  socket.user_id = user_id;
  socket.redis = redis;

  console.log(`🔐 用户认证成功: ${user.name} (${user._id}) | 状态: ${socket.isGuest ? '游客' : '登陆'}`);

  next();
}

/**
 * 登陆验证中间件 - 用于需要登陆的事件
 */
export function requireLogin(socket: AuthSocket, next: (err?: Error) => void) {
  if (!socket.isLoggedIn) {
    return next(new Error('此操作需要登陆'));
  }
  next();
}

/**
 * 检查权限的辅助函数
 */
export function hasPermission(socket: AuthSocket, permission: string): boolean {
  // 游客权限：只能查看、不能操作
  if (socket.isGuest) {
    const guestPermissions = ['view-games', 'view-rooms', 'view-leaderboard', 'view-stats'];
    return guestPermissions.includes(permission);
  }

  // 登陆用户权限：完全权限
  if (socket.isLoggedIn) {
    return true;
  }

  return false;
}

/**
 * 权限检查装饰器
 */
export function checkPermission(permission: string) {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;

    descriptor.value = function (socket: AuthSocket, ...args: any[]) {
      if (!hasPermission(socket, permission)) {
        socket.emit('error', {
          code: 'PERMISSION_DENIED',
          message: '您没有权限执行此操作'
        });
        return;
      }

      return originalMethod.apply(this, [socket, ...args]);
    };

    return descriptor;
  };
}