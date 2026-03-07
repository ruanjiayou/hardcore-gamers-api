import { MUser } from '../models'
import * as z from "zod";
import redis from '../utils/redis'
import config from '../config';
import { isEmpty } from 'lodash';

const VUser = z.object({
  name: z.string().trim().min(1, '参数必填'),
  pass: z.string().trim().min(6, '长度最少为6').max(18, '长度最多18'),
});

export class UserService {

  async getInfoById(_id: string) {
    const user = await MUser.findById(_id, { pass: 0 }).lean(true);
    return user;
  }

  async getStats() {
    const key = config.prefix + 'stats:users'
    let stats: { [key: string]: string | number } = await redis.hgetall(key)
    if (isEmpty(stats)) {
      const total = await MUser.countDocuments({ online: true });
      stats = { total }
      await redis.pipeline().hmset(key, stats).expire(key, config.expires).exec()
    }
    return stats;
  }
}

export const userService = new UserService();