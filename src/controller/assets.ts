/**
 * 资源 HTTP 接口（挂载在 /api/assets）。
 *
 * GET  /api/assets/:game/manifest.json
 *   一次下发该游戏的全部资源（SB-066）：图片 URL、按分组的外观清单、音频。
 *   **只有该游戏自己那一份**——没有通用层、没有经典/街机主题包的概念。
 * GET  /api/assets/:game/skins   本游戏可装备的外观（含 owned/equipped）
 * POST /api/assets/equip         { game, asset_id, slot:'skin'|'corpse' }（需登录）
 * POST /api/assets/skin          旧接口兼容（内部解析成 asset_id，写 skin 槽）
 */
import { Router } from 'express';
import { httpAuth, type AuthedRequest } from '../middleware/httpAuth';
import { userFromRequest } from '../services/VoicePackService';
import { assetsService } from '../services/AssetsService';
import { MAsset } from '../models';

const router = Router();

const gameOf = (req: any): string => String(req.params.game || '');

router.get('/:game/manifest.json', async (req, res) => {
  try {
    const game = gameOf(req);
    const user = userFromRequest(req);
    const data = await assetsService.buildManifest({ game, userId: user?._id as string | undefined });
    // UI-112：清单含玩家级装备，属于用户专属响应，不能走浏览器/代理 HTTP 缓存
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code: 0, data });
  } catch (err: any) {
    res.json({ code: -1, message: err?.message || '获取资源清单失败' });
  }
});

router.get('/:game/skins', async (req, res) => {
  try {
    const game = gameOf(req);
    const user = userFromRequest(req);
    const manifest = await assetsService.buildManifest({ game, userId: user?._id as string | undefined });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code: 0, data: manifest.skins });
  } catch (err: any) {
    res.json({ code: -1, message: err?.message || '获取皮肤列表失败' });
  }
});

router.post('/equip', httpAuth, async (req: AuthedRequest, res) => {
  try {
    const game = String(req.body?.game || 'snake');
    const assetId = String(req.body?.asset_id || '');
    const slot = req.body?.slot === 'corpse' ? 'corpse' : 'skin';
    const data = await assetsService.equipSkin(req.user_id!, game, assetId, slot);
    res.json({ code: 0, data });
  } catch (err: any) {
    res.json({ code: -1, message: err?.message || '保存皮肤失败' });
  }
});

/** 旧接口兼容：`{skin}` 既可以是 asset_id，也可以是资源 key */
router.post('/skin', httpAuth, async (req: AuthedRequest, res) => {
  try {
    const game = String(req.body?.game || 'snake');
    const raw = String(req.body?.skin || '');
    let assetId = raw;
    const byId = raw ? await MAsset.findById(raw, { _id: 1 }).lean(true) : null;
    if (!byId) {
      const byKey = await MAsset.findOne({ equippable: true, key: raw, status: { $ne: 0 } }, { _id: 1 })
        .sort({ updatedAt: -1 }).lean(true);
      assetId = String((byKey as any)?._id || '');
    }
    const data = await assetsService.equipSkin(req.user_id!, game, assetId, 'skin');
    res.json({ code: 0, data: { skin: data.asset_id } });
  } catch (err: any) {
    res.json({ code: -1, message: err?.message || '保存皮肤失败' });
  }
});

export default router;
