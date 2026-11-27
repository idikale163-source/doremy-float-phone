import type { DesktopIconId } from "@/lib/desktop-config";
import {
  loadDesktopFolders,
  loadDockLayout,
  normalizeDesktopFolders,
  normalizeDesktopIconLayout,
  normalizeDock,
  type DesktopFolderMap,
  type DesktopIconLayout,
} from "@/lib/desktop-layout-storage";
import { kvGet, kvRemove, kvSet, registerKvMigration } from "@/lib/kv-db";
import { normalizeThemeProfile, type ThemeProfile } from "@/lib/theme-types";
import { GRID_COLS, GRID_ROWS, WIDGET_SIZE_CELLS, type WidgetInstance, type WidgetSize } from "@/lib/widget-types";

const THEME_PRESETS_STORAGE_KEY = "ai_phone_theme_presets_v1";
const THEME_PRESET_VERSION = 1;
export const THEME_PRESET_LIMIT = 20;

registerKvMigration(THEME_PRESETS_STORAGE_KEY);

export type ThemePreset = {
  version: typeof THEME_PRESET_VERSION;
  id: string;
  name: string;
  themeProfile: ThemeProfile;
  iconLayout: DesktopIconLayout;
  widgets: WidgetInstance[];
  dock: DesktopIconId[];
  folders: DesktopFolderMap;
  createdAt: string;
  updatedAt: string;
};

export type ThemePresetSnapshot = {
  themeProfile: ThemeProfile;
  iconLayout: DesktopIconLayout;
  widgets: WidgetInstance[];
};

function createPresetId(): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `theme_preset_${suffix}`;
}

function normalizePresetName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 24) : "";
}

function normalizePresetWidgets(raw: unknown): WidgetInstance[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): WidgetInstance[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const size = typeof candidate.size === "string" && candidate.size in WIDGET_SIZE_CELLS
      ? candidate.size as WidgetSize
      : null;
    if (
      typeof candidate.id !== "string"
      || typeof candidate.type !== "string"
      || !size
      || typeof candidate.page !== "number"
      || !Number.isInteger(candidate.page)
      || candidate.page < 1
      || typeof candidate.row !== "number"
      || typeof candidate.col !== "number"
    ) {
      return [];
    }

    const [rows, cols] = WIDGET_SIZE_CELLS[size];
    if (
      candidate.row < 1
      || candidate.col < 1
      || candidate.row + rows - 1 > GRID_ROWS
      || candidate.col + cols - 1 > GRID_COLS
    ) {
      return [];
    }

    const config = candidate.config && typeof candidate.config === "object" && !Array.isArray(candidate.config)
      ? candidate.config as Record<string, unknown>
      : undefined;
    return [{
      id: candidate.id,
      type: candidate.type,
      size,
      page: candidate.page,
      row: candidate.row,
      col: candidate.col,
      ...(config ? { config } : {}),
    }];
  });
}

function normalizePreset(raw: unknown): ThemePreset | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<ThemePreset>;
  const name = normalizePresetName(source.name);
  if (!name || typeof source.id !== "string" || !source.id.trim()) return null;

  const folders = normalizeDesktopFolders(source.folders);
  const iconLayout = normalizeDesktopIconLayout(source.iconLayout, new Set(Object.keys(folders)));
  const createdAt = typeof source.createdAt === "string" ? source.createdAt : new Date().toISOString();
  const updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : createdAt;

  return {
    version: THEME_PRESET_VERSION,
    id: source.id.trim(),
    name,
    themeProfile: normalizeThemeProfile(source.themeProfile),
    iconLayout,
    widgets: normalizePresetWidgets(source.widgets),
    dock: normalizeDock(source.dock),
    folders,
    createdAt,
    updatedAt,
  };
}

function writeThemePresets(presets: ThemePreset[]): void {
  if (presets.length === 0) {
    kvRemove(THEME_PRESETS_STORAGE_KEY);
    return;
  }
  kvSet(THEME_PRESETS_STORAGE_KEY, JSON.stringify(presets.slice(0, THEME_PRESET_LIMIT)));
}

export function readThemePresets(): ThemePreset[] {
  const raw = kvGet(THEME_PRESETS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .map(normalizePreset)
      .filter((preset): preset is ThemePreset => {
        if (!preset || seen.has(preset.id)) return false;
        seen.add(preset.id);
        return true;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, THEME_PRESET_LIMIT);
  } catch {
    return [];
  }
}

export function saveThemePreset(name: string, snapshot: ThemePresetSnapshot): ThemePreset {
  const normalizedName = normalizePresetName(name);
  if (!normalizedName) throw new Error("请输入预设名称");

  const current = readThemePresets();
  const existing = current.find((item) => item.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase());
  if (!existing && current.length >= THEME_PRESET_LIMIT) {
    throw new Error(`最多保存 ${THEME_PRESET_LIMIT} 个主题预设，请先删除不需要的预设`);
  }

  const now = new Date().toISOString();
  const folders = loadDesktopFolders();
  const preset = normalizePreset({
    version: THEME_PRESET_VERSION,
    id: existing?.id ?? createPresetId(),
    name: normalizedName,
    themeProfile: {
      ...snapshot.themeProfile,
      name: normalizedName,
      // 预设只记录当前选中的壁纸；壁纸库是跨预设共享的用户素材库。
      wallpaperLibrary: snapshot.themeProfile.wallpaperAssetId
        ? [snapshot.themeProfile.wallpaperAssetId]
        : [],
    },
    iconLayout: snapshot.iconLayout,
    widgets: snapshot.widgets,
    dock: loadDockLayout(),
    folders,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  if (!preset) throw new Error("主题预设保存失败");

  writeThemePresets([preset, ...current.filter((item) => item.id !== preset.id)]);
  return preset;
}

export function deleteThemePreset(id: string): void {
  writeThemePresets(readThemePresets().filter((item) => item.id !== id));
}

export function themePresetUsesAsset(assetId: string): boolean {
  if (!assetId) return false;
  return readThemePresets().some((preset) => {
    const profile = preset.themeProfile;
    if (
      profile.wallpaperAssetId === assetId
      || profile.fontAssetId === assetId
      || profile.dockSkinAssetId === assetId
    ) {
      return true;
    }
    if (Object.values(profile.iconSkins).includes(assetId)) return true;
    return profile.iconSchemes.some((scheme) => Object.values(scheme.iconSkins).includes(assetId));
  });
}
