/**
 * 资源 HTTP 接口（挂载在 /api/assets）。
 *
 * GET  /api/assets/manifest.json?game=snake[&pack=arcade]
 *   一次下发该游戏的全部资源：图片 URL、按分组的外观清单、音频（BGM+音效）。
 *   **只含当前游戏的那一份**（外加 UI 通用音）——黑白棋拿不到贪吃蛇的皮肤或音效。
 *   前端在加载阶段预解码，对局内只按 asset_id 查内存，零图片请求。
 * GET  /api/assets/skins?game=snake[&pack=]   本游戏可装备的外观（含 owned/equipped）
 * POST /api/assets/equip { game, asset_id }  装备外观（需登录）
 * POST /api/assets/skin  { skin: <id|key> }  旧接口兼容（内部解析成 asset_id）
 */
import { Router } from 'express';
import { httpAuth, type AuthedRequest } from '../middleware/httpAuth';
import { userFromRequest, voicePackService } from '../services/VoicePackService';
import { assetsService } from '../services/AssetsService';
import { MAsset } from '../models';

const router = Router();

/** 把 `game` 参数规范化：缺省 snake（目前唯一有外观配置的游戏） */
function gameOf(req: any): string {
  return String(req.query.game || 'snake');
}

router.get('/manifest.json', async (req, res) => {
  try {
    const game = gameOf(req);
    const user = userFromRequest(req);
    const wanted = req.query.pack ? String(req.query.pack) : undefined;
    const packId = await voicePackService.resolvePackId(user?._id as string | undefined, wanted);
    const data = await assetsService.buildManifest({ game, packId, userId: user?._id as string | undefined });
    // 清单跟着包/资源的更新时间走，允许浏览器短缓存
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ code: 0, data });
  } catch (err: any) {
    res.json({ code: -1, message: err?.message || '获取资源清单失败' });
  }
});

router.get('/skins', async (req, res) => {
  try {
    const game = gameOf(req);
    const user = userFromRequest(req);
    const wanted = req.query.pack ? String(req.query.pack) : undefined;
    const packId = await voicePackService.resolvePackId(user?._id as string | undefined, wanted);
    const manifest = await assetsService.buildManifest({ game, packId, userId: user?._id as string | undefined });
    res.json({ code: 0, data: manifest.skins });
  } catch (err: any) {
    res.json({ code: -1, message: err?.message || '获取皮肤列表失败' });
  }
});

router.post('/equip', httpAuth, async (req: AuthedRequest, res) => {
  try {
    const game = String(req.body?.game || 'snake');
    const assetId = String(req.body?.asset_id || '');
    const data = await assetsService.equipSkin(req.user_id!, game, assetId);
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
      // 按 key 找「玩家级可装备的外观」：不按分组名硬编码（以前写死 group='snake'，
      // 换个游戏的皮肤就再也装备不了了）
      const byKey = await MAsset.findOne({ equippable: true, key: raw, status: { $ne: 0 } }, { _id: 1 })
        .sort({ updatedAt: -1 }).lean(true);
      assetId = String((byKey as any)?._id || '');
    }
    const data = await assetsService.equipSkin(req.user_id!, game, assetId);
    res.json({ code: 0, data });
  } catch (err: any) {
    res.json({ code: -1, message: err?.message || '保存皮肤失败' });
  }
});

export default router;
