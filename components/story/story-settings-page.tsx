"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, PhotoIcon, PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/solid";
import { Maximize2, Play, Download, Upload } from "lucide-react";
import { TextExpandModal } from "@/components/ui/modal";
import { CustomStatusFrame } from "@/components/chat/custom-status-frame";
import { StoryPaginationManager, type StoryBranchCreateInput } from "@/components/story/story-pagination-manager";
import { downloadFile } from "@/lib/download-utils";
import type { Character } from "@/lib/character-types";
import type { PresetConfig } from "@/lib/settings-types";
import type { StoryCharacterSettings, StoryGroup, StoryProseStyleScheme, StoryQuickInputScheme, StorySchemeRepository, StorySession, StoryTailScheme, StoryUiPrefs } from "@/lib/story-storage";
import {
  STORY_DEFAULT_STATUS_RENDER,
  STORY_DEFAULT_THEATER_RENDER,
  STORY_DEFAULT_QUICK_INPUT_OPTIONS,
} from "@/lib/story-storage";

// 兼容旧导入（story-app-base 从这里取渲染画布常量）
export { STORY_DEFAULT_STATUS_RENDER, STORY_DEFAULT_THEATER_RENDER };

type StorySettingsPageProps = {
  characters: Character[];
  activeCharacterId: string;
  activeGroupId: string;
  groups: StoryGroup[];
  ownerSessions: StorySession[];
  activeSessionId: string;
  userName: string;
  uiPrefs: StoryUiPrefs;
  settings: StoryCharacterSettings;
  /** 公用方案仓库：文风/状态栏/小剧场/快捷输入方案的定义（所有角色共享）。 */
  schemeRepo: StorySchemeRepository;
  boundPreset: PresetConfig | null;
  foldTags: string;
  contextExcludedTags: string;
  onClose: () => void;
  onCharacterChange: (characterId: string) => void;
  onGroupSelect: (groupId: string) => void;
  onGroupCreate: (characterIds: string[], name: string) => void;
  onGroupRename: (groupId: string, name: string) => void;
  onGroupDelete: (groupId: string) => void;
  onSessionSelect: (sessionId: string) => void;
  onBranchCreate: (input: StoryBranchCreateInput) => void;
  onBranchDelete: (sessionIds: string[]) => void;
  onSessionUpdate: (sessionId: string, updates: Partial<StorySession>) => void;
  onExportSession: (sessionId: string) => void;
  onExportAll: () => void;
  onUiPrefsChange: (prefs: StoryUiPrefs) => void;
  onSettingsChange: (settings: StoryCharacterSettings) => void;
  /** 编辑公用仓库里的方案定义（新增/删除/改名/改内容都在这里落盘）。 */
  onSchemeRepoChange: (repo: StorySchemeRepository) => void;
  onTagsChange: (foldTags: string, contextExcludedTags: string) => void;
  onOpenCss: () => void;
  onRebuildCache: () => void;
};

function normalizeSettings(value: StoryCharacterSettings, repo: StorySchemeRepository): StoryCharacterSettings {
  return {
    ...value,
    presetName: value.presetName || "默认剧情",
    minChars: value.minChars ?? 800,
    maxChars: value.maxChars ?? 1500,
    userPerspective: value.userPerspective || "second",
    // 启用选择超出仓库范围时回落：旧 id → 按旧文风名匹配 → 首个方案
    activeProseStyleSchemeId: repo.proseStyleSchemes.some((item) => item.id === value.activeProseStyleSchemeId)
      ? value.activeProseStyleSchemeId
      : repo.proseStyleSchemes.find((item) => item.name === value.proseStyle)?.id || repo.proseStyleSchemes[0].id,
    activeStatusSchemeId: repo.statusSchemes.some((item) => item.id === value.activeStatusSchemeId)
      ? value.activeStatusSchemeId
      : repo.statusSchemes[0].id,
    activeTheaterSchemeId: repo.theaterSchemes.some((item) => item.id === value.activeTheaterSchemeId)
      ? value.activeTheaterSchemeId
      : repo.theaterSchemes[0].id,
  };
}

function ProseStyleEditor({
  schemes,
  activeId,
  onChange,
}: {
  schemes: StoryProseStyleScheme[];
  activeId: string;
  onChange: (schemes: StoryProseStyleScheme[], activeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = schemes.find((item) => item.id === activeId) || schemes[0];
  const updateActive = (updates: Partial<StoryProseStyleScheme>) => {
    onChange(schemes.map((item) => item.id === active.id ? { ...item, ...updates } : item), active.id);
  };

  return (
    <div className="story-scheme-editor story-prose-style-editor">
      <div className="story-settings-label-row"><label>文风方案</label><span>所有角色共用，当前角色选择启用哪一套</span></div>
      <div className="story-settings-inline story-settings-inline-with-save">
        <select value={active.id} onChange={(event) => onChange(schemes, event.target.value)}>
          {schemes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" aria-label="新增文风方案" onClick={() => {
          const id = `story-style-${Date.now()}`;
          const next = [...schemes, { id, name: `文风方案 ${schemes.length + 1}`, prompt: "" }];
          onChange(next, id);
        }}><PlusIcon width={15} /></button>
        <button type="button" aria-label="删除文风方案" disabled={schemes.length <= 1} onClick={() => {
          if (schemes.length <= 1) return;
          const next = schemes.filter((item) => item.id !== active.id);
          onChange(next, next[0].id);
        }}><TrashIcon width={14} /></button>
        <button type="button" className="story-scheme-save" onClick={() => onChange(schemes, active.id)}>保存</button>
      </div>
      <input value={active.name} onChange={(event) => updateActive({ name: event.target.value })} placeholder="文风方案名称" />
      <div className="story-prompt-textarea-wrap">
        <textarea
          value={active.prompt}
          onChange={(event) => updateActive({ prompt: event.target.value })}
          placeholder="填写写给 AI 的文风要求，例如叙述节奏、用词和描写重点"
        />
        <button type="button" className="story-prompt-expand" onClick={() => setExpanded(true)} aria-label="放大编辑文风提示词" title="放大编辑">
          <Maximize2 size={14} />
        </button>
      </div>
      <p className="story-settings-note">文风方案保存在公用仓库，所有角色共享同一套方案；修改会同步影响每个角色。</p>
      {expanded ? (
        <TextExpandModal
          title={`${active.name || "文风方案"} · 文风要求`}
          value={active.prompt}
          onChange={(prompt) => updateActive({ prompt })}
          placeholder="填写写给 AI 的正文文风要求。这里不需要填写状态栏、小剧场或其他尾部输出格式。"
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </div>
  );
}

// 剧情字数输入：编辑期间允许清空、全选重输，不做强制纠正；失焦或回车才落库。
// 存成 0 或超过 10000 时原样保留用户数字，由生成引擎在提示词里收敛到 50–10000。
function CharLimitInput({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);
  const commitDraft = () => {
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? NaN : Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    onCommit(Math.trunc(parsed));
    setDraft(String(Math.trunc(parsed)));
  };
  const outOfRange = value < 50 || value > 10000;
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={50}
        max={10000}
        inputMode="numeric"
        value={draft}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commitDraft(); }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
      <small className="story-char-limit-hint" data-out={outOfRange ? "true" : undefined}>{outOfRange ? `已保存 ${value}，生成时按 50–10000 生效` : "范围 50–10000"}</small>
    </label>
  );
}

function SettingCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="story-settings-card">
      <div className="story-settings-card-head">
        <div>
          <h2>{title}</h2>
          {hint ? <p>{hint}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function ToggleRow({ title, detail, checked, onChange }: { title: string; detail?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="story-settings-toggle-row">
      <span><strong>{title}</strong>{detail ? <small>{detail}</small> : null}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SchemeEditor({
  label,
  schemes,
  activeId,
  tag,
  contextNote,
  onChange,
}: {
  label: string;
  schemes: StoryTailScheme[];
  activeId: string;
  tag: string;
  contextNote: string;
  onChange: (schemes: StoryTailScheme[], activeId: string) => void;
}) {
  const active = schemes.find((item) => item.id === activeId) || schemes[0];
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftSchemes, setDraftSchemes] = useState<StoryTailScheme[]>(schemes);
  const [draftId, setDraftId] = useState(active.id);
  const draft = draftSchemes.find((item) => item.id === draftId) || draftSchemes[0] || active;
  const [previewHtml, setPreviewHtml] = useState(draft.renderHtml || "");
  const [expandedField, setExpandedField] = useState<"prompt" | "render" | null>(null);
  useEffect(() => {
    if (editorOpen) return;
    setDraftSchemes(schemes);
    setDraftId(active.id);
    setPreviewHtml(active.renderHtml || "");
  }, [active.id, active.renderHtml, editorOpen, schemes]);

  const updateDraft = (updates: Partial<StoryTailScheme>) => {
    setDraftSchemes((items) => items.map((item) => item.id === draft.id ? { ...item, ...updates } : item));
  };
  const openEditor = () => {
    setDraftSchemes(schemes.map((item) => ({ ...item })));
    setDraftId(active.id);
    setPreviewHtml(active.renderHtml || "");
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
    setExpandedField(null);
  };

  // ── 方案导入导出 ──────────────────────────────────────────
  // 导出：当前类型的全部方案打包成一个 JSON 文件（去掉本机 id，导入时重新生成）；
  // 导入：识别导出文件 / 方案数组 / 单个方案对象，合并进编辑列表，重名自动加序号。
  const kind = tag === "story_theater" ? "theater" : "status";
  const kindLabel = tag === "story_theater" ? "小剧场" : "状态栏";
  const fileRef = useRef<HTMLInputElement | null>(null);

  const exportSchemes = async () => {
    try {
      const payload = {
        type: "ai-phone-story-scheme",
        version: 1,
        kind,
        schemes: draftSchemes.map((item) => ({ name: item.name, prompt: item.prompt, renderHtml: item.renderHtml || "", preview: item.preview || "" })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      await downloadFile(blob, `剧情${kindLabel}方案.json`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "导出失败，请重试");
    }
  };

  const importSchemes = async (file: File) => {
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(await file.text()); } catch { throw new Error("文件不是有效的 JSON，请确认是方案导出文件"); }
      let incoming: unknown[];
      if (Array.isArray(parsed)) incoming = parsed;
      else if (parsed && typeof parsed === "object") {
        const wrapper = parsed as { kind?: string; schemes?: unknown; name?: unknown; prompt?: unknown; renderHtml?: unknown };
        // 带 kind 标记的文件导错了编辑器时直接拦下，避免状态栏/小剧场互串
        if (typeof wrapper.kind === "string" && wrapper.kind !== kind) {
          throw new Error(`这是「${wrapper.kind === "theater" ? "小剧场" : "状态栏"}」方案文件，请在对应的方案编辑器里导入`);
        }
        if (Array.isArray(wrapper.schemes)) incoming = wrapper.schemes;
        else if (typeof wrapper.name === "string" || typeof wrapper.prompt === "string" || typeof wrapper.renderHtml === "string") incoming = [wrapper];
        else throw new Error("没有找到有效的方案（方案需要包含名称、输出契约或渲染 HTML）");
      } else throw new Error("文件内容不是有效的方案数据");

      const sanitize = (raw: unknown): StoryTailScheme | null => {
        if (!raw || typeof raw !== "object") return null;
        const item = raw as Record<string, unknown>;
        const name = typeof item.name === "string" ? item.name.trim().slice(0, 40) : "";
        const prompt = typeof item.prompt === "string" ? item.prompt : "";
        const renderHtml = typeof item.renderHtml === "string" ? item.renderHtml : "";
        const preview = typeof item.preview === "string" ? item.preview : "";
        if (!name && !prompt.trim() && !renderHtml.trim()) return null;
        return { id: `${tag}-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: name || "导入的方案", prompt, renderHtml, preview };
      };
      const imported = incoming.map(sanitize).filter((item): item is StoryTailScheme => item !== null);
      if (!imported.length) throw new Error("没有找到有效的方案（方案需要包含名称、输出契约或渲染 HTML）");

      const existing = new Set(draftSchemes.map((item) => item.name));
      const renamed = imported.map((item) => {
        if (!existing.has(item.name)) { existing.add(item.name); return item; }
        let n = 2;
        while (existing.has(`${item.name} ${n}`)) n += 1;
        const name = `${item.name} ${n}`;
        existing.add(name);
        return { ...item, name };
      });
      setDraftSchemes((items) => [...items, ...renamed]);
      setDraftId(renamed[0].id);
      setPreviewHtml(renamed[0].renderHtml || "");
    } catch (err) {
      alert(err instanceof Error ? err.message : "导入失败，请重试");
    }
  };

  return (
    <div className="story-scheme-editor">
      <button type="button" className="story-tail-editor-entry" onClick={openEditor}>
        <span><strong>{label}</strong><small>{active.name} · {contextNote}</small></span>
        <ChevronLeftIcon width={17} style={{ transform: "rotate(180deg)" }} />
      </button>

      {editorOpen ? (
        <div className="story-tail-editor-overlay" onClick={closeEditor}>
          <section className="story-tail-editor-modal" role="dialog" aria-modal="true" aria-label={`自定义${label}`} onClick={(event) => event.stopPropagation()}>
            <header className="story-tail-editor-header">
              <strong>自定义{tag === "story_theater" ? "小剧场" : "状态栏"}</strong>
              <button type="button" onClick={closeEditor} aria-label="关闭"><XMarkIcon width={19} /></button>
            </header>

            <div className="story-tail-editor-scroll">
              <div className="story-tail-scheme-row">
                <select value={draft.id} onChange={(event) => {
                  const next = draftSchemes.find((item) => item.id === event.target.value);
                  setDraftId(event.target.value);
                  setPreviewHtml(next?.renderHtml || "");
                }}>
                  {draftSchemes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <button type="button" aria-label={`新增${label}`} onClick={() => {
                  const id = `${tag}-${Date.now()}`;
                  const next: StoryTailScheme = { id, name: `${label} ${draftSchemes.length + 1}`, prompt: `在正文末尾输出 <${tag}>...</${tag}>。`, renderHtml: "", preview: "" };
                  setDraftSchemes((items) => [...items, next]);
                  setDraftId(id);
                  setPreviewHtml("");
                }}><PlusIcon width={16} /></button>
                <button type="button" aria-label={`删除${label}`} disabled={draftSchemes.length <= 1} onClick={() => {
                  if (draftSchemes.length <= 1) return;
                  const next = draftSchemes.filter((item) => item.id !== draft.id);
                  setDraftSchemes(next);
                  setDraftId(next[0].id);
                  setPreviewHtml(next[0].renderHtml || "");
                }}><TrashIcon width={15} /></button>
                <button type="button" aria-label={`导出${label}`} title={`导出全部${label}为文件`} onClick={() => void exportSchemes()}><Download size={15} /></button>
                <button type="button" aria-label={`导入${label}`} title={`从文件导入${label}`} onClick={() => fileRef.current?.click()}><Upload size={15} /></button>
              </div>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importSchemes(file);
                event.target.value = "";
              }} />
              <p className="story-tail-io-note">导出会把全部{kindLabel}方案存成一个 JSON 文件；导入会把文件里的方案追加进列表（重名自动加序号），点「保存并启用」生效。</p>
              <input className="story-tail-name-input" value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="方案名称" />

              <div className="story-tail-field-head"><strong>输出契约</strong><small>整节写进提示词</small></div>
              <div className="story-prompt-textarea-wrap">
                <textarea value={draft.prompt} onChange={(event) => updateDraft({ prompt: event.target.value })} placeholder={`写给 AI 的输出契约，要求使用 <${tag}> 标签`} />
                <button type="button" className="story-prompt-expand" onClick={() => setExpandedField("prompt")} aria-label="放大编辑输出契约"><Maximize2 size={14} /></button>
              </div>

              <div className="story-tail-field-head"><strong>输出渲染</strong><small>HTML · 沙盒运行</small></div>
              <div className="story-prompt-textarea-wrap">
                <textarea className="story-render-textarea" value={draft.renderHtml || ""} onChange={(event) => updateDraft({ renderHtml: event.target.value })} placeholder="填写 HTML/CSS/JS；可用 {{RAW}} 或 window.STORY_RAW 读取输出原文" spellCheck={false} />
                <button type="button" className="story-prompt-expand" onClick={() => setExpandedField("render")} aria-label="放大编辑输出渲染"><Maximize2 size={14} /></button>
              </div>

              <div className="story-settings-preview">
                <div className="story-tail-preview-head"><span><strong>预览</strong><small>示例数据可改</small></span><button type="button" onClick={() => setPreviewHtml(draft.renderHtml || "")} aria-label="运行预览" title="运行预览"><Play size={15} /></button></div>
                <textarea value={draft.preview} onChange={(event) => updateDraft({ preview: event.target.value })} placeholder="在这里编辑预览内容" />
                {previewHtml.trim() ? <div className="story-tail-preview-frame"><CustomStatusFrame key={`${draft.id}:${previewHtml}:${draft.preview}`} html={previewHtml} raw={draft.preview} kind={tag === "story_theater" ? "theater" : "status"} title={`${label}预览`} /></div> : <div className="story-tail-preview-empty">填写输出渲染后点击播放预览</div>}
              </div>
            </div>

            <footer className="story-tail-editor-footer">
              <button type="button" onClick={closeEditor}>取消</button>
              <button type="button" className="story-tail-editor-save" onClick={() => { onChange(draftSchemes, draft.id); closeEditor(); }}>保存并启用</button>
            </footer>

            {expandedField ? <TextExpandModal
              title={`${draft.name || label} · ${expandedField === "prompt" ? "输出契约" : "输出渲染"}`}
              value={expandedField === "prompt" ? draft.prompt : draft.renderHtml || ""}
              onChange={(value) => updateDraft(expandedField === "prompt" ? { prompt: value } : { renderHtml: value })}
              placeholder={expandedField === "prompt" ? `要求 AI 使用 <${tag}> 标签输出内容` : "填写 HTML/CSS/JS；使用 window.STORY_RAW 读取原文"}
              onClose={() => setExpandedField(null)}
            /> : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function QuickOptionsEditor({
  options,
  onChange,
}: {
  options: string[];
  onChange: (options: string[]) => void;
}) {
  const updateOption = (index: number, value: string) => {
    onChange(options.map((item, i) => (i === index ? value : item)));
  };
  const removeOption = (index: number) => {
    onChange(options.filter((_, i) => i !== index));
  };

  return (
    <div className="story-quick-options-editor">
      <div className="story-settings-subhead">
        <strong>快捷选项</strong>
        <button className="story-settings-mini-add" type="button" onClick={() => onChange([...options, ""])}><PlusIcon width={13} />增加</button>
      </div>
      <div className="story-quick-options">
        {options.map((option, index) => (
          <div key={index} className="story-quick-option-item">
            <input
              value={option}
              maxLength={16}
              placeholder="符号或短语"
              onChange={(event) => updateOption(index, event.target.value)}
            />
            <button
              type="button"
              aria-label="删除快捷选项"
              disabled={options.length <= 1}
              onClick={() => removeOption(index)}
            >
              <TrashIcon width={13} />
            </button>
          </div>
        ))}
        {!options.length ? <p className="story-settings-empty">没有选项，点“增加”添加。</p> : null}
      </div>
      <p className="story-settings-note">留空的选项不会显示在面板里；删除全部后剧情页会使用默认选项 “” 「」 ，？ ……。</p>
    </div>
  );
}

export function StorySettingsPage(props: StorySettingsPageProps) {
  const normalized = useMemo(() => normalizeSettings(props.settings, props.schemeRepo), [props.settings, props.schemeRepo]);
  const repo = props.schemeRepo;
  // 方案定义 → 公用仓库；启用选择 → 当前角色设置
  const patchRepo = (updates: Partial<StorySchemeRepository>) => {
    props.onSchemeRepoChange({ ...repo, ...updates });
  };
  const quickInputActive = repo.quickInputSchemes.find((item) => item.id === props.uiPrefs.activeQuickInputSchemeId) || repo.quickInputSchemes[0];
  const updateQuickInputScheme = (updates: Partial<StoryQuickInputScheme>) => {
    if (!quickInputActive) return;
    patchRepo({ quickInputSchemes: repo.quickInputSchemes.map((item) => item.id === quickInputActive.id ? { ...item, ...updates } : item) });
  };
  const [wallpaperOpen, setWallpaperOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fontFileRef = useRef<HTMLInputElement | null>(null);
  const [fontUrlDraft, setFontUrlDraft] = useState(props.uiPrefs.customFontUrl || "");
  useEffect(() => {
    setFontUrlDraft(props.uiPrefs.customFontUrl || "");
  }, [props.activeSessionId, props.uiPrefs.customFontUrl]);
  const availablePrompts = useMemo(
    () => (props.boundPreset?.prompts || []).filter((item) => !item.marker && item.content?.trim()),
    [props.boundPreset],
  );
  const selectedPromptIds = normalized.enabledPresetPromptIds ?? availablePrompts.filter((item) => item.enabled).map((item) => item.identifier);

  const patchSettings = (updates: Partial<StoryCharacterSettings>) => {
    props.onSettingsChange({ ...normalized, ...updates });
  };

  const readWallpaper = (file?: File) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => props.onUiPrefsChange({ ...props.uiPrefs, wallpaper: typeof reader.result === "string" ? reader.result : undefined });
    reader.readAsDataURL(file);
  };

  const readCustomFont = (file?: File) => {
    if (!file) return;
    const supported = /\.(?:ttf|otf|woff2?)$/i.test(file.name) || file.type.startsWith("font/") || file.type === "application/font-woff";
    if (!supported) {
      window.alert("请选择 TTF、OTF、WOFF 或 WOFF2 字体文件");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      window.alert("字体文件不能超过 8MB，建议使用精简后的 WOFF2 字体");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setFontUrlDraft("");
      props.onUiPrefsChange({
        ...props.uiPrefs,
        customFontDataUrl: reader.result,
        customFontUrl: undefined,
        customFontName: file.name,
      });
    };
    reader.readAsDataURL(file);
  };

  const applyCustomFontUrl = () => {
    const value = fontUrlDraft.trim();
    if (value && !/^https?:\/\//i.test(value)) {
      window.alert("请填写以 http:// 或 https:// 开头的字体直链");
      return;
    }
    props.onUiPrefsChange({
      ...props.uiPrefs,
      customFontDataUrl: undefined,
      customFontUrl: value || undefined,
      customFontName: value ? "URL 字体" : undefined,
    });
  };

  if (wallpaperOpen) {
    return (
      <div className="story-settings-page story-wallpaper-page">
        <header className="story-settings-header">
          <button type="button" onClick={() => setWallpaperOpen(false)} aria-label="返回剧情设置"><ChevronLeftIcon width={19} /></button>
          <strong>背景壁纸</strong><span />
        </header>
        <main className="story-wallpaper-main">
          <div className="story-wallpaper-preview" style={props.uiPrefs.wallpaper ? { backgroundImage: `url(${props.uiPrefs.wallpaper})` } : undefined}>
            {!props.uiPrefs.wallpaper ? <><PhotoIcon width={30} /><span>当前未设置剧情壁纸</span></> : null}
          </div>
          <input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => readWallpaper(event.target.files?.[0])} />
          <button className="story-settings-primary" type="button" onClick={() => fileRef.current?.click()}>从手机相册选择</button>
          {props.uiPrefs.wallpaper ? <button className="story-settings-danger" type="button" onClick={() => props.onUiPrefsChange({ ...props.uiPrefs, wallpaper: undefined })}>清除当前壁纸</button> : null}
          <p>壁纸只应用于当前见面对象的剧情页面，不影响聊天、主页和其他角色。</p>
        </main>
      </div>
    );
  }

  return (
    <div className="story-settings-page">
      <header className="story-settings-header">
        <button type="button" onClick={props.onClose} aria-label="返回剧情"><ChevronLeftIcon width={19} /></button>
        <strong>剧情设置</strong>
        <button type="button" onClick={props.onClose} aria-label="关闭设置"><XMarkIcon width={17} /></button>
      </header>
      <main className="story-settings-scroll">
        <StoryPaginationManager
          characters={props.characters}
          activeCharacterId={props.activeCharacterId}
          activeGroupId={props.activeGroupId}
          groups={props.groups}
          sessions={props.ownerSessions}
          activeSessionId={props.activeSessionId}
          userName={props.userName}
          onCharacterChange={props.onCharacterChange}
          onGroupSelect={props.onGroupSelect}
          onGroupCreate={props.onGroupCreate}
          onGroupRename={props.onGroupRename}
          onGroupDelete={props.onGroupDelete}
          onSessionSelect={props.onSessionSelect}
          onBranchCreate={props.onBranchCreate}
          onBranchDelete={props.onBranchDelete}
          onSessionUpdate={props.onSessionUpdate}
          onExportSession={props.onExportSession}
          onExportAll={props.onExportAll}
        />

        <SettingCard title="剧情预设设置" hint="建议给剧情 APP 单独制作专属预设，避免影响其他应用">
          <label className="story-settings-field"><span>当前角色专属预设名称</span><input value={normalized.presetName} onChange={(event) => patchSettings({ presetName: event.target.value })} /></label>
          <label className="story-settings-field"><span>剧情额外要求</span><textarea value={normalized.extraPrompt || ""} onChange={(event) => patchSettings({ extraPrompt: event.target.value })} placeholder="仅在当前角色的剧情生成中使用" /></label>
          <div className="story-settings-subhead"><strong>专属预设条目</strong><button className="story-settings-mini-add" type="button" onClick={() => patchSettings({ customPromptEntries: [...(normalized.customPromptEntries || []), { id: `story-entry-${Date.now()}`, name: `新条目 ${(normalized.customPromptEntries?.length || 0) + 1}`, content: "", enabled: true }] })}><PlusIcon width={13} />增加</button></div>
          <div className="story-custom-entry-list">
            {(normalized.customPromptEntries || []).map((entry) => (
              <div key={entry.id}>
                <label className="story-custom-entry-title"><input type="checkbox" checked={entry.enabled} onChange={(event) => patchSettings({ customPromptEntries: normalized.customPromptEntries!.map((item) => item.id === entry.id ? { ...item, enabled: event.target.checked } : item) })} /><input value={entry.name} onChange={(event) => patchSettings({ customPromptEntries: normalized.customPromptEntries!.map((item) => item.id === entry.id ? { ...item, name: event.target.value } : item) })} /><button type="button" onClick={() => patchSettings({ customPromptEntries: normalized.customPromptEntries!.filter((item) => item.id !== entry.id) })}><TrashIcon width={13} /></button></label>
                <textarea value={entry.content} onChange={(event) => patchSettings({ customPromptEntries: normalized.customPromptEntries!.map((item) => item.id === entry.id ? { ...item, content: event.target.value } : item) })} placeholder="填写这一条剧情专属提示词" />
              </div>
            ))}
            {!normalized.customPromptEntries?.length ? <p className="story-settings-empty">暂无专属条目，可按需要增加；它们只影响当前角色的剧情。</p> : null}
          </div>
          <div className="story-settings-subhead"><strong>操作已绑定大预设条目</strong><small>{props.boundPreset?.name || "未绑定大预设"}</small></div>
          {availablePrompts.length ? (
            <div className="story-preset-prompt-list">
              {availablePrompts.map((prompt) => (
                <label key={prompt.identifier}>
                  <input type="checkbox" checked={selectedPromptIds.includes(prompt.identifier)} onChange={(event) => {
                    const next = event.target.checked ? [...selectedPromptIds, prompt.identifier] : selectedPromptIds.filter((id) => id !== prompt.identifier);
                    patchSettings({ enabledPresetPromptIds: Array.from(new Set(next)) });
                  }} />
                  <span><strong>{prompt.name || prompt.identifier}</strong><small>{prompt.content.slice(0, 70)}</small></span>
                </label>
              ))}
            </div>
          ) : <p className="story-settings-empty">请先在“配置绑定”中给剧情 APP 绑定大预设。</p>}
        </SettingCard>

        <SettingCard title="生成设置" hint="检查预设条目与生成设置是否重复">
          <div className="story-number-grid">
            <CharLimitInput label="最少字数" value={normalized.minChars ?? 800} onCommit={(minChars) => patchSettings({ minChars })} />
            <CharLimitInput label="最多字数" value={normalized.maxChars ?? 1500} onCommit={(maxChars) => patchSettings({ maxChars })} />
          </div>
          <label className="story-settings-field"><span>用户人称</span><select value={normalized.userPerspective} onChange={(event) => patchSettings({ userPerspective: event.target.value as StoryCharacterSettings["userPerspective"] })}><option value="second">第二人称“你”</option><option value="third">第三人称“TA”</option><option value="username">使用用户名“{props.userName}”</option></select></label>
          <ProseStyleEditor schemes={repo.proseStyleSchemes} activeId={normalized.activeProseStyleSchemeId!} onChange={(proseStyleSchemes, activeProseStyleSchemeId) => { patchRepo({ proseStyleSchemes }); patchSettings({ activeProseStyleSchemeId }); }} />
        </SettingCard>

        <SettingCard title="语音与播放">
          <ToggleRow title="开启语音" detail="启动当前角色绑定到剧情 APP 的语音；不会自动阅读" checked={Boolean(props.uiPrefs.voiceEnabled)} onChange={(value) => props.onUiPrefsChange({ ...props.uiPrefs, voiceEnabled: value })} />
          {props.activeGroupId ? <p className="story-settings-note">多人剧情角色语音不统一，当前可能默认绑定第一个角色的语音。</p> : null}
          <p className="story-settings-note">总播放键按次播放下一句；每句对白末尾的小按钮仍可单独播放。</p>
        </SettingCard>

        <SettingCard title="自定义字体" hint="只应用于当前剧情会话；可上传字体文件或填写字体直链">
          <input
            ref={fontFileRef}
            hidden
            type="file"
            accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
            onChange={(event) => {
              readCustomFont(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button className="story-font-upload-button" type="button" onClick={() => fontFileRef.current?.click()}>
            <span><strong>上传字体文件</strong><small>{props.uiPrefs.customFontDataUrl ? `${props.uiPrefs.customFontName || "已上传字体"} · 已自动应用` : "支持 TTF / OTF / WOFF / WOFF2，最大 8MB"}</small></span>
            <Upload size={16} />
          </button>
          <label className="story-settings-field">
            <span>字体 URL</span>
            <input value={fontUrlDraft} onChange={(event) => setFontUrlDraft(event.target.value)} placeholder="https://example.com/font.woff2" />
          </label>
          <div className="story-font-actions">
            <button type="button" className="story-font-apply" onClick={applyCustomFontUrl}>应用字体 URL</button>
            {(props.uiPrefs.customFontDataUrl || props.uiPrefs.customFontUrl) ? (
              <button type="button" className="story-font-reset" onClick={() => {
                setFontUrlDraft("");
                props.onUiPrefsChange({ ...props.uiPrefs, customFontDataUrl: undefined, customFontUrl: undefined, customFontName: undefined });
              }}>恢复默认字体</button>
            ) : null}
          </div>
          <p className="story-settings-note">远程字体必须是可直接访问的字体文件，并允许跨域加载；否则浏览器会自动回退到默认剧情字体。</p>
        </SettingCard>

        <SettingCard title="自动阅读" hint="开启后可在“续写”旁启动自动滚动，解放双手阅读">
          <ToggleRow title="开启自动阅读" detail="可从最新角色消息或当前页面位置开始" checked={Boolean(props.uiPrefs.autoReadingEnabled)} onChange={(value) => props.onUiPrefsChange({ ...props.uiPrefs, autoReadingEnabled: value })} />
          {props.uiPrefs.autoReadingEnabled ? (
            <label className="story-auto-reading-speed">
              <span><strong>阅读速度</strong><small>{props.uiPrefs.autoReadingSpeed ?? 36} 像素/秒</small></span>
              <input
                type="range"
                min={12}
                max={120}
                step={4}
                value={props.uiPrefs.autoReadingSpeed ?? 36}
                onChange={(event) => props.onUiPrefsChange({ ...props.uiPrefs, autoReadingSpeed: Number(event.target.value) })}
              />
              <div><small>慢</small><small>快</small></div>
            </label>
          ) : null}
        </SettingCard>

        <SettingCard title="快捷输入面板" hint="开启后“续写”右侧出现“输入”按钮；方案保存在公用仓库，所有角色共享">
          <ToggleRow
            title="开启快捷输入面板"
            detail="输入框上方展开窄长横幅，点按选项即插入输入框，选项过多可左右滑动"
            checked={Boolean(props.uiPrefs.quickInputEnabled)}
            onChange={(value) => props.onUiPrefsChange({ ...props.uiPrefs, quickInputEnabled: value })}
          />
          {props.uiPrefs.quickInputEnabled && quickInputActive ? (
            <>
              <div className="story-settings-label-row"><label>输入方案</label><span>所有角色共用，当前角色选择启用哪一套</span></div>
              <div className="story-settings-inline">
                <select value={quickInputActive.id} onChange={(event) => props.onUiPrefsChange({ ...props.uiPrefs, activeQuickInputSchemeId: event.target.value })}>
                  {repo.quickInputSchemes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <button type="button" aria-label="新增快捷输入方案" onClick={() => {
                  const id = `quick-${Date.now()}`;
                  patchRepo({ quickInputSchemes: [...repo.quickInputSchemes, { id, name: `输入方案 ${repo.quickInputSchemes.length + 1}`, options: [...STORY_DEFAULT_QUICK_INPUT_OPTIONS], cursor: "middle" as const }] });
                  props.onUiPrefsChange({ ...props.uiPrefs, activeQuickInputSchemeId: id });
                }}><PlusIcon width={15} /></button>
                <button type="button" aria-label="删除快捷输入方案" disabled={repo.quickInputSchemes.length <= 1} onClick={() => {
                  if (repo.quickInputSchemes.length <= 1) return;
                  const next = repo.quickInputSchemes.filter((item) => item.id !== quickInputActive.id);
                  patchRepo({ quickInputSchemes: next });
                  props.onUiPrefsChange({ ...props.uiPrefs, activeQuickInputSchemeId: next[0].id });
                }}><TrashIcon width={14} /></button>
              </div>
              <div className="story-quick-cursor-row">
                <span className="story-quick-cursor-label">插入后光标位置</span>
                <div className="story-quick-cursor-options" role="radiogroup" aria-label="插入后光标位置">
                  {([["left", "选项左边"], ["middle", "选项中间"], ["right", "选项右边"]] as const).map(([value, label]) => {
                    const active = (quickInputActive.cursor ?? "middle") === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        data-active={active ? "true" : undefined}
                        onClick={() => updateQuickInputScheme({ cursor: value })}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <QuickOptionsEditor
                options={quickInputActive.options}
                onChange={(options) => updateQuickInputScheme({ options })}
              />
              <p className="story-settings-note">点按面板选项时按上面设置的光标位置插入；“选项中间”适合成对引号，光标会落在引号正中。方案保存在公用仓库，修改会同步影响所有角色。</p>
            </>
          ) : null}
        </SettingCard>

        <SettingCard title="剧情尾部" hint="状态栏与小剧场方案保存在公用仓库，所有角色共享；每个角色单独选择启用哪一套">
          <SchemeEditor label="状态栏方案" schemes={repo.statusSchemes} activeId={normalized.activeStatusSchemeId!} tag="story_status" contextNote="进入上下文" onChange={(schemes, activeStatusSchemeId) => { patchRepo({ statusSchemes: schemes }); patchSettings({ activeStatusSchemeId }); }} />
          <SchemeEditor label="小剧场方案" schemes={repo.theaterSchemes} activeId={normalized.activeTheaterSchemeId!} tag="story_theater" contextNote="默认不进上下文" onChange={(schemes, activeTheaterSchemeId) => { patchRepo({ theaterSchemes: schemes }); patchSettings({ activeTheaterSchemeId }); }} />
        </SettingCard>

        <SettingCard title="悬浮小手机" hint="开启后剧情正文右侧出现手机悬浮球">
          <ToggleRow title="启用悬浮小手机" detail="居中打开窄版小手机，显示与当前角色的线上聊天记录" checked={Boolean(normalized.floatingPhoneEnabled)} onChange={(value) => patchSettings({ floatingPhoneEnabled: value })} />
          <ToggleRow title="聊天记录衔接剧情上下文" detail="生成剧情时带入小手机最近的线上消息" checked={Boolean(normalized.floatingPhoneInContext)} onChange={(value) => patchSettings({ floatingPhoneInContext: value })} />
        </SettingCard>

        <SettingCard title="标签与高级设置">
          <label className="story-settings-field"><span>折叠标签</span><input value={props.foldTags} onChange={(event) => props.onTagsChange(event.target.value, props.contextExcludedTags)} placeholder="think,thinking,story_status,story_theater" /></label>
          <label className="story-settings-field"><span>不进上下文标签</span><input value={props.contextExcludedTags} onChange={(event) => props.onTagsChange(props.foldTags, event.target.value)} placeholder="think,thinking,story_theater" /></label>
          <button className="story-settings-row-button" type="button" onClick={() => setWallpaperOpen(true)}><span><strong>背景壁纸</strong><small>{props.uiPrefs.wallpaper ? "已设置 · 仅当前角色" : "未设置"}</small></span><ChevronLeftIcon width={17} style={{ transform: "rotate(180deg)" }} /></button>
          <button className="story-settings-row-button" type="button" onClick={props.onOpenCss}><span><strong>页面 CSS 样式</strong><small>进入完整样式编辑页面</small></span><ChevronLeftIcon width={17} style={{ transform: "rotate(180deg)" }} /></button>
          <button className="story-settings-row-button" type="button" onClick={props.onRebuildCache}><span><strong>重建剧情渲染缓存</strong><small>方案或标签变化后使用</small></span><ChevronLeftIcon width={17} style={{ transform: "rotate(180deg)" }} /></button>
        </SettingCard>
      </main>
    </div>
  );
}
