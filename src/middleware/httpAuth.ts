/**
 * HTTP 鉴权中间件（Bearer token）。
 *
 * Socket 侧已经有 authMiddleware；HTTP 侧此前完全没有身份校验（写接口靠"没人知道"）。
 * 个人中心改资料 / 改密码必须有身份，所以这里补一个最小实现：
 * 验签 JWT → 把 `_id` 挂到 req.user_id，失败直接 401（前端据此触发 refresh_token 续期）。
 */
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';

export interface AuthedRequest extends Request {
  user_id?: string;
}

export function httpAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    res.status(401).json({ code: 401, message: '请先登录' });
    return;
  }
  try {
    const data: any = jwt.verify(token, config.secret);
    if (!data?._id) throw new Error('bad token');
    req.user_id = data._id;
    next();
  } catch {
    res.status(401).json({ code: 401, message: '登录已过期' });
  }
}
