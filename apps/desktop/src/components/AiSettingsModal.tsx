import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Languages, LoaderCircle, MessageSquareText, RotateCcw, Save, X } from "lucide-react";
import type { PromptOverrideSettings } from "@aivs/schemas";
import { getAiSettings, saveAiSettings } from "../services/backend";
import { VIDEO_STORYBOARD_DETAILED_PROMPT, VIDEO_STORYBOARD_PROMPT } from "../prompts/videoStoryboard";
import { CHARACTER_IMAGE_PROMPT } from "../prompts/characterImage";
import { supportedLocales, useI18n } from "../i18n";

function readableError(error: unknown): string {
  const value = String(error ?? "发生未知错误");
  try { return (JSON.parse(value) as { message?: string }).message || value; } catch { return value; }
}

export function AiSettingsModal({ onClose }: { onClose: () => void }) {
  const { locale, direction, setLocale, t } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["ai-settings"], queryFn: getAiSettings });
  const [videoStoryboardPrompt, setVideoStoryboardPrompt] = useState(VIDEO_STORYBOARD_PROMPT);
  const [videoStoryboardDetailedPrompt, setVideoStoryboardDetailedPrompt] = useState(VIDEO_STORYBOARD_DETAILED_PROMPT);
  const [characterImagePrompt, setCharacterImagePrompt] = useState(CHARACTER_IMAGE_PROMPT);
  const [promptOverrides, setPromptOverrides] = useState<PromptOverrideSettings>({
    video_storyboard_prompt: false,
    video_storyboard_detailed_prompt: false,
    character_image_prompt: false,
  });
  const [activeTab, setActiveTab] = useState<"general" | "prompt">("general");

  useEffect(() => {
    if (!settings.data) return;
    setVideoStoryboardPrompt(settings.data.video_storyboard_prompt || VIDEO_STORYBOARD_PROMPT);
    setVideoStoryboardDetailedPrompt(settings.data.video_storyboard_detailed_prompt || VIDEO_STORYBOARD_DETAILED_PROMPT);
    setCharacterImagePrompt(settings.data.character_image_prompt || CHARACTER_IMAGE_PROMPT);
    setPromptOverrides(settings.data.prompt_overrides);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => {
      const current = settings.data;
      if (!current) throw new Error("设置尚未加载，请稍后重试。");
      // Preserve settings that are no longer editable in this dialog.
      return saveAiSettings({
        base_url: current.base_url,
        agent_model: current.agent_model,
        video_model: current.video_model,
        image_model: current.image_model,
        image_protocol: current.image_protocol,
        video_generation_model: current.video_generation_model,
        video_generation_protocol: current.video_generation_protocol,
        credit_costs: current.credit_costs,
        video_storyboard_prompt: videoStoryboardPrompt,
        video_storyboard_detailed_prompt: videoStoryboardDetailedPrompt,
        character_image_prompt: characterImagePrompt,
        prompt_overrides: promptOverrides,
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["ai-settings"], result);
    },
  });

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
      <header>
        <div><span className="eyebrow">SYSTEM SETTINGS</span><h2 id="ai-settings-title">{t("systemSettings")}</h2><p>管理界面语言与提示词；画风和创作类型由服务端统一维护。</p></div>
        <button className="modal-close" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
      </header>
      <div className="settings-tabs" role="tablist" aria-label="系统设置分类">
        <button className={activeTab === "general" ? "active" : ""} type="button" role="tab" aria-selected={activeTab === "general"} onClick={() => setActiveTab("general")}><Languages size={16} /><span><strong>{t("general")}</strong><small>{t("language")}</small></span></button>
        <button className={activeTab === "prompt" ? "active" : ""} type="button" role="tab" aria-selected={activeTab === "prompt"} onClick={() => setActiveTab("prompt")}><MessageSquareText size={16} /><span><strong>{t("promptSettings")}</strong><small>视频理解与角色生图模板</small></span></button>
      </div>
      <div className="settings-body">
        {settings.isLoading ? <div className="settings-loading"><LoaderCircle className="spin" /> 正在读取安全配置…</div> : <>
          {activeTab === "general" ? <div className="settings-tab-panel language-settings-panel" role="tabpanel">
            <div className="prompt-settings-intro"><Languages size={20} /><div><strong>{t("interfaceLanguageTitle")}</strong><span>{t("interfaceLanguageDesc")}</span></div></div>
            <label>{t("language")}<select value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>{supportedLocales.map((item) => <option key={item.code} value={item.code}>{item.nativeName}</option>)}</select><small>{t("languageHint")}</small></label>
            {direction === "rtl" && <div className="settings-guidance"><Languages size={19} /><div><strong>RTL</strong><span>{t("rtlNotice")}</span></div></div>}
            <p className="language-support-note">{t("minoritySupport")}</p>
          </div> : <div className="settings-tab-panel prompt-settings-panel" role="tabpanel">
            <div className="settings-guidance"><AlertTriangle size={19} /><div><strong>{settings.data?.prompt_defaults.source === "SERVER" ? "默认提示词已从服务端加载" : "服务端暂不可用，当前使用本地缓存提示词"}</strong><span>{settings.data?.prompt_defaults.source === "SERVER" ? `配置频道：${settings.data.prompt_defaults.channel}。客户端会优先采用服务端发布版本；手动编辑后仅在本机覆盖对应提示词。` : "重新打开设置时会再次尝试读取服务端；手动编辑的本地覆盖不会被替换。"}</span></div></div>
            <div className="prompt-settings-grid">
              <section className="prompt-settings-card">
                <div className="prompt-settings-intro"><MessageSquareText size={20} /><div><strong>标准模式视频理解提示词（推荐）</strong><span>用于快速生成结构化项目剧情、角色、场景和分镜。</span></div></div>
                <label className="settings-prompt-field"><span className="settings-prompt-heading"><span>默认视频理解提示词 · {promptOverrides.video_storyboard_prompt ? "本地覆盖" : `服务端默认${settings.data?.prompt_defaults.versions.video_storyboard_prompt ? ` v${settings.data.prompt_defaults.versions.video_storyboard_prompt}` : ""}`}</span><button type="button" onClick={() => { setVideoStoryboardPrompt(settings.data?.prompt_defaults.video_storyboard_prompt || VIDEO_STORYBOARD_PROMPT); setPromptOverrides((current) => ({ ...current, video_storyboard_prompt: false })); }}><RotateCcw size={14} /> 恢复服务端默认</button></span><textarea rows={22} value={videoStoryboardPrompt} onChange={(event) => { setVideoStoryboardPrompt(event.target.value); setPromptOverrides((current) => ({ ...current, video_storyboard_prompt: true })); }} /><small>建议保留角色 ID、场景 ID、时间段及所有字段标签；编辑后会保存为本机覆盖，不影响服务端配置。</small></label>
              </section>
              <section className="prompt-settings-card">
                <div className="prompt-settings-intro"><MessageSquareText size={20} /><div><strong>详细模式视频理解提示词</strong><span>每个分镜的画面会按内容节奏细分到秒，并写明运镜与对应台词。</span></div></div>
                <label className="settings-prompt-field"><span className="settings-prompt-heading"><span>详细视频理解提示词 · {promptOverrides.video_storyboard_detailed_prompt ? "本地覆盖" : `服务端默认${settings.data?.prompt_defaults.versions.video_storyboard_detailed_prompt ? ` v${settings.data.prompt_defaults.versions.video_storyboard_detailed_prompt}` : ""}`}</span><button type="button" onClick={() => { setVideoStoryboardDetailedPrompt(settings.data?.prompt_defaults.video_storyboard_detailed_prompt || VIDEO_STORYBOARD_DETAILED_PROMPT); setPromptOverrides((current) => ({ ...current, video_storyboard_detailed_prompt: false })); }}><RotateCcw size={14} /> 恢复服务端默认</button></span><textarea rows={22} value={videoStoryboardDetailedPrompt} onChange={(event) => { setVideoStoryboardDetailedPrompt(event.target.value); setPromptOverrides((current) => ({ ...current, video_storyboard_detailed_prompt: true })); }} /><small>详细模式仍依赖原有字段标签创建项目；编辑后会保存为本机覆盖。</small></label>
              </section>
              <section className="prompt-settings-card">
                <div className="prompt-settings-intro"><MessageSquareText size={20} /><div><strong>角色生图提示词</strong><span>用于角色页的“生图”和“一键生图”，系统会自动替换双花括号占位符。</span></div></div>
                <label className="settings-prompt-field"><span className="settings-prompt-heading"><span>默认角色生图提示词 · {promptOverrides.character_image_prompt ? "本地覆盖" : `服务端默认${settings.data?.prompt_defaults.versions.character_image_prompt ? ` v${settings.data.prompt_defaults.versions.character_image_prompt}` : ""}`}</span><button type="button" onClick={() => { setCharacterImagePrompt(settings.data?.prompt_defaults.character_image_prompt || CHARACTER_IMAGE_PROMPT); setPromptOverrides((current) => ({ ...current, character_image_prompt: false })); }}><RotateCcw size={14} /> 恢复服务端默认</button></span><textarea rows={18} value={characterImagePrompt} onChange={(event) => { setCharacterImagePrompt(event.target.value); setPromptOverrides((current) => ({ ...current, character_image_prompt: true })); }} /><small>可用占位符：&#123;&#123;visual_style&#125;&#125;、&#123;&#123;character_name&#125;&#125;、&#123;&#123;character_role&#125;&#125;、&#123;&#123;gender_age&#125;&#125;、&#123;&#123;appearance_lock&#125;&#125;、&#123;&#123;clothing_lock&#125;&#125;、&#123;&#123;accessories&#125;&#125;。编辑后会保存为本机覆盖。</small></label>
              </section>
            </div>
          </div>}
          {(settings.error || save.error) && <div className="error-banner">{readableError(settings.error ?? save.error)}</div>}
          {save.isSuccess && <div className="settings-success"><CheckCircle2 size={16} /> {t("settingsSaved")}</div>}
        </>}
      </div>
      <footer><button className="secondary-button" type="button" onClick={onClose}>{t("cancel")}</button><button className="primary-button" type="button" disabled={save.isPending || !settings.data || videoStoryboardPrompt.trim().length < 50 || videoStoryboardDetailedPrompt.trim().length < 50 || characterImagePrompt.trim().length < 50} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} {t("saveSettings")}</button></footer>
    </section>
  </div>;
}
