import { Router } from 'express';
import { oauthService } from '../services/OAuthService';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const data = await oauthService.login(req.body.name, req.body.pass)
    res.json({ code: 0, data });
  } catch (err: any) {
    res.json({ code: -1, message: err.message });
  }
});

router.post('/register', async (req, res) => {
  try {
    const data = await oauthService.register(req.body)
    res.json({ code: 0, data });
  } catch (err: any) {
    res.json({ code: -1, message: err.message });
  }
})

/**
 * 用 refresh_token 续期 access_token。
 * access_token 只有 30h，前端（lobby/services/api.ts）在 401 或 socket 认证过期时自动调用，
 * 用户不用因为"挂了一晚上"被踢回登录页。
 */
router.post('/refresh', async (req, res) => {
  try {
    const data = await oauthService.refresh(req.body?.refresh_token);
    res.json({ code: 0, data });
  } catch (err: any) {
    res.status(401).json({ code: 401, message: err.message });
  }
});

export default router;