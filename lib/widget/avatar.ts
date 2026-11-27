"use client";

/**
 * 桌面小组件的状态头像：让角色给自己生成一张配当前状态的图。
 *
 * 为什么单独成模块：
 *   生图很慢（几秒到几十秒），而且用户可能压根没配生图 API。
 *   把它从「写一句话」的主流程里分出来，没配就干净地降级成
 *   「角色名首字 + 稳定底色」，不必在每个调用点各写一遍降级逻辑。
 *
 * 产物是 **data URL**，不是链接：
 *   原生渲染时 blockNetworkLoads=true（模板里的 http 图片一律不加载，
 *   否则一张慢图会把整次渲染卡死），所以头像必须自带数据。
 *   也因此这里要压到很小——data URL 会随 HTML 一起过 JS 桥。
 */

import { generateImageFromConfiguredApi } from "../image-generation-service";
import { loadImageGenerationSettings } from "../settings-storage";
import type { Character } from "../character-types";

/** 头像最终边长（像素）。桌面小组件上就一个 38px 的小圆，256 绰绰有余。 */
const AVATAR_SIZE = 256;

/** 压出来的 JPEG 质量。0.82 在 256px 下通常只有 15-30KB。 */
const AVATAR_QUALITY = 0.82;

/** 生图是否可用（用户配了且启用）。没配时调用方直接走降级。 */
export function canGenerateAvatar(): boolean {
  try {
    return loadImageGenerationSettings().enabled === true;
  } catch {
    return false;
  }
}

/**
 * 把任意图片压成小尺寸 data URL。
 *
 * 用 canvas 重画而不是直接存原图：生图服务给的往往是大图，
 * 直接塞进小组件会撑爆 Binder 传输上限（1MB）导致桌面显示不出来。
 */
async function downscaleToDataUrl(source: string): Promise<string | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(null); return; }
        // 居中裁成正方形：头像框是圆的，非方图直接缩放会变形
        const side = Math.min(image.width, image.height);
        const sx = (image.width - side) / 2;
        const sy = (image.height - side) / 2;
        ctx.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
        resolve(canvas.toDataURL("image/jpeg", AVATAR_QUALITY));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

/**
 * 给角色生成一张配当前状态的头像。
 *
 * @returns data URL；没配生图、生成失败、或压图失败时返回 null（调用方走降级）
 */
export async function generateWidgetAvatar(
  character: Character,
  status: string,
  text: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!canGenerateAvatar()) return null;

  // 提示词写人话即可——具体怎么组装由生图 service 里的预设决定，
  // 这里只负责把「这是谁、现在什么心情」说清楚。
  const mood = status.trim() || "平静";
  const hint = text.trim().slice(0, 40);
  const description = [
    `${character.name} 的自拍式头像`,
    character.briefPersona?.trim() || character.personality?.trim() || character.persona?.trim().slice(0, 80) || "",
    `当前状态：${mood}`,
    hint ? `心境：${hint}` : "",
    "半身特写，温柔的光线，构图居中，适合用作圆形头像",
  ].filter(Boolean).join("。");

  try {
    const result = await generateImageFromConfiguredApi({
      description,
      characterId: character.id,
      appId: "phone_widget",
      useReferenceImage: true,
      signal,
    });
    if (!result) return null;
    return await downscaleToDataUrl(result.dataUrl);
  } catch (err) {
    console.warn("[Widget] 状态头像生成失败", err);
    return null;
  }
}
