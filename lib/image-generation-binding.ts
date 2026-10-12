import type { ImageGenerationSettings, OpenAiImagePreset, NovelAiPreset } from "./settings-types";

const OPENAI_PREFIX = "openai:";
const NOVELAI_PREFIX = "novelai:";

export type ImageGenerationBindingOption = {
  id: string;
  name: string;
  provider: "openai" | "novelai";
};

function openAiPresets(settings: ImageGenerationSettings): OpenAiImagePreset[] {
  return Array.isArray(settings.openaiPresets) ? settings.openaiPresets : [];
}

function novelAiPresets(settings: ImageGenerationSettings): NovelAiPreset[] {
  return Array.isArray(settings.novelai?.presets) ? settings.novelai.presets : [];
}

export function getImageGenerationBindingOptions(settings: ImageGenerationSettings): ImageGenerationBindingOption[] {
  return [
    ...openAiPresets(settings).map((preset) => ({
      id: `${OPENAI_PREFIX}${preset.id}`,
      name: `OpenAI · ${preset.name || "未命名方案"}`,
      provider: "openai" as const,
    })),
    ...novelAiPresets(settings).map((preset) => ({
      id: `${NOVELAI_PREFIX}${preset.id}`,
      name: `NovelAI · ${preset.name || "未命名方案"}`,
      provider: "novelai" as const,
    })),
  ];
}

export function getActiveImageGenerationBindingId(settings: ImageGenerationSettings): string | undefined {
  if (settings.provider === "novelai") {
    const activeId = settings.novelai?.activePresetId;
    if (activeId && novelAiPresets(settings).some((preset) => preset.id === activeId)) {
      return `${NOVELAI_PREFIX}${activeId}`;
    }
  }

  const activeId = settings.activeOpenAiPresetId;
  if (activeId && openAiPresets(settings).some((preset) => preset.id === activeId)) {
    return `${OPENAI_PREFIX}${activeId}`;
  }
  return getImageGenerationBindingOptions(settings)[0]?.id;
}

export function applyImageGenerationBinding(
  settings: ImageGenerationSettings,
  bindingId: string | undefined,
): ImageGenerationSettings {
  if (!bindingId) return settings;

  if (bindingId.startsWith(OPENAI_PREFIX)) {
    const presetId = bindingId.slice(OPENAI_PREFIX.length);
    const preset = openAiPresets(settings).find((item) => item.id === presetId);
    if (!preset) return settings;
    return {
      ...settings,
      provider: "openai",
      requestMode: preset.requestMode,
      apiKey: preset.apiKey,
      baseUrl: preset.baseUrl,
      model: preset.model,
      size: preset.size,
      quality: preset.quality,
      extraPrompt: preset.extraPrompt,
      activeOpenAiPresetId: preset.id,
    };
  }

  if (bindingId.startsWith(NOVELAI_PREFIX)) {
    const presetId = bindingId.slice(NOVELAI_PREFIX.length);
    const preset = novelAiPresets(settings).find((item) => item.id === presetId);
    if (!preset || !settings.novelai) return settings;
    return {
      ...settings,
      provider: "novelai",
      novelai: {
        ...settings.novelai,
        activePresetId: preset.id,
      },
    };
  }

  return settings;
}
