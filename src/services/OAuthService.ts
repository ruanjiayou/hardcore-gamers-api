import { v7 } from 'uuid';
import { MPlayer, MUser } from '../models'
import crypto from 'node:crypto'
import { omit, pick } from 'lodash';
import { IUser } from '../types';
import * as z from "zod";
import jwt from 'jsonwebtoken'
import config from '../config';

const VUser = z.object({
  name: z.string().trim().min(1, '参数必填'),
  pass: z.string().trim().min(6, '长度最少为6').max(18, '长度最多18'),
});

/** 个人中心可改的字段（头像支持 emoji 或图片 URL，暂不做文件上传） */
const VProfile = z.object({
  nickname: z.string().trim().min(1, '昵称不能为空').max(20, '昵称最多 20 个字符').optional(),
  avatar: z.string().trim().max(500, '头像地址过长').optional(),
  email: z.union([z.string().trim().email('邮箱格式不正确'), z.literal('')]).optional(),
  phone: z.union([z.string().trim().regex(/^\d{5,20}$/, '手机号格式不正确'), z.literal('')]).optional(),
});

const ACCESS_TTL = '30h';
const REFRESH_TTL = '30d';

export class OAuthService {

  async login(name: string, pass: string) {
    const user = await MUser.findOne({ name }).lean(true);
    if (!user) {
      return this.register({ name, pass });
    }
    if (crypto.createHash('md5').update(pass).digest('hex') !== user.pass) {
      throw new Error('账号或密码错误')
    }
    const token = await this.getTokens(user);
    return { user: this.publicUser(user), token };
  }

  async register(data: Partial<IUser>) {
    const result = VUser.safeParse(data);
    if (result.success) {
      const _id = v7();
      result.data.pass = crypto.createHash('md5').update(result.data.pass).digest('hex');
      await MUser.create({ ...result.data, _id, nickname: result.data.name });
      const user = await MUser.findById(_id).lean(true);
      return { user: this.publicUser(user), token: this.getTokens(user) };
    } else {
      console.log(result.error)
      throw new Error('参数错误')
    }
  }

  /**
   * 用 refresh_token 换一对新令牌。
   * access_token 只有 30h，前端在 401 / socket 认证过期时自动续期（见 lobby/services/api.ts）。
   */
  async refresh(refresh_token: string) {
    if (!refresh_token) throw new Error('缺少 refresh_token');
    let data: any;
    try {
      data = jwt.verify(refresh_token, config.secret);
    } catch {
      throw new Error('登录已过期，请重新登录');
    }
    if (data?.typ !== 'refresh' || !data?._id) throw new Error('refresh_token 无效');
    const user = await MUser.findById(data._id).lean(true);
    if (!user) throw new Error('用户不存在');
    return { user: this.publicUser(user), token: this.getTokens(user) };
  }

  async getTokens(user: IUser) {
    return {
      access_token: jwt.sign(pick(user, ['_id', 'name']), config.secret, { expiresIn: ACCESS_TTL, jwtid: v7() }),
      refresh_token: jwt.sign({ _id: user._id, typ: 'refresh' }, config.secret, { expiresIn: REFRESH_TTL, jwtid: v7() }),
    };
  }

  /** 个人中心改资料：昵称/头像同时同步到该用户的全部 player（房间、排行榜显示的是 player） */
  async updateProfile(user_id: string, input: Partial<Pick<IUser, 'nickname' | 'avatar' | 'email' | 'phone'>>) {
    const parsed = VProfile.safeParse(input);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message || '参数错误');
    }
    const patch: Record<string, any> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined) patch[k] = v;
    }
    if (!Object.keys(patch).length) throw new Error('没有需要修改的内容');
    patch.updatedAt = new Date();
    const user = await MUser.findByIdAndUpdate(user_id, { $set: patch }, { new: true }).lean(true);
    if (!user) throw new Error('用户不存在');

    const playerPatch: Record<string, any> = { updatedAt: new Date() };
    if (patch.nickname !== undefined) playerPatch.nickname = patch.nickname;
    if (patch.avatar !== undefined) playerPatch.avatar = patch.avatar;
    if (Object.keys(playerPatch).length > 1) {
      await MPlayer.updateMany({ user_id, type: 'player' }, { $set: playerPatch });
    }
    return this.publicUser(user);
  }

  /** 改密码：旧密码校验后写新 MD5；已签发的 token 不强制失效（30h 内自然过期） */
  async changePassword(user_id: string, old_pass: string, new_pass: string) {
    const check = VUser.pick({ pass: true }).safeParse({ pass: new_pass });
    if (!check.success) throw new Error('新密码长度需为 6–18 位');
    const next = check.data.pass;
    const user = await MUser.findById(user_id).lean(true);
    if (!user) throw new Error('用户不存在');
    if (crypto.createHash('md5').update(String(old_pass || '')).digest('hex') !== user.pass) {
      throw new Error('旧密码不正确');
    }
    await MUser.updateOne({ _id: user_id }, {
      $set: { pass: crypto.createHash('md5').update(next).digest('hex'), updatedAt: new Date() },
    });
    return true;
  }

  /** 对外输出：去掉 pass，昵称缺省回退登录名 */
  publicUser(user: any) {
    if (!user) return user;
    return { ...omit(user, ['pass']), nickname: user.nickname || user.name };
  }
}

export const oauthService = new OAuthService();
