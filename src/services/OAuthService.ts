import { v7 } from 'uuid';
import { MUser } from '../models'
import crypto from 'node:crypto'
import { omit, pick } from 'lodash';
import { IUser } from '../types';
import * as z from "zod";
import jwt from 'jsonwebtoken'

const VUser = z.object({
  name: z.string().trim().min(1, '参数必填'),
  pass: z.string().trim().min(6, '长度最少为6').max(18, '长度最多18'),
});

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
    return { user: omit(user, ['pass']), token };
  }

  async register(data: Partial<IUser>) {
    const result = VUser.safeParse(data);
    if (result.success) {
      const _id = v7();
      result.data.pass = crypto.createHash('md5').update(result.data.pass).digest('hex');
      await MUser.create({ ...result.data, _id, });
      const user = await MUser.findById(_id).lean(true);
      const token = {
        access_token: jwt.sign(pick(user, ['_id', 'name']), 'test', { expiresIn: '30h', jwtid: v7() }),
        refresh_token: '',
      }
      return { user: omit(user, ['pass']), token };
    } else {
      console.log(result.error)
      throw new Error('参数错误')
    }
  }

  async getTokens(user: IUser) {
    return {
      access_token: jwt.sign(pick(user, ['_id', 'name']), 'test', { expiresIn: '30h', jwtid: v7() }),
      refresh_token: '',
    }
  }
}

export const oauthService = new OAuthService();