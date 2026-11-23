/**
 * 语音包 HTTP 接口。
 * GET  /api/voice-packs          列表（含权限虚拟字段）+ 当前选择，游客也能读
 * POST /api/voice-packs/select   选择语音包，需登录且必须有权限
 */
import { Router } from 'express';
import { userFromRequest, voicePackService } from '../services/VoicePackService';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const user = userFromRequest(req);
    const data = await voicePackService.listForUser(user?._id);
    res.json({ code: 0, data });
  } catch (err: any) {
    res.json({ code: -1, message: err?.message || '获取语音包失败' });
  }
});

router.post('/select', async (req, res) => {
  try {
    const user = userFromRequest(req);
    if (!user?._id) {
      res.json({ code: -1, message: '请先登录' });
      return;
    }
    const packId = String(req.body?.pack_id || req.body?.id || '');
    const data = await voicePackService.selectPack(user._id as string, packId);
    res.json({ code: 0, data });
  } catch (err: any) {
    res.json({ code: -1, message: err?.message || '选择语音包失败' });
  }
});

export default router;
