import React, { useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  createServiceFromPreset,
  LANGUAGE_OPTIONS,
  SERVICE_PRESETS,
} from '../../../src/storage';
import type {
  ExtensionSettings,
  LanguageCode,
  ServicePresetType,
  ServiceProfile,
  TargetLanguageCode,
} from '../../../src/types';

interface ServicesTabProps {
  settings: ExtensionSettings;
  patchSettings: (
    updater:
      | Partial<ExtensionSettings>
      | ((prev: ExtensionSettings) => ExtensionSettings),
  ) => Promise<ExtensionSettings>;
}

export const ServicesTab: React.FC<ServicesTabProps> = ({
  settings,
  patchSettings,
}) => {
  const [selectedPreset, setSelectedPreset] =
    useState<ServicePresetType>('bilibili-index');
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [testingMap, setTestingMap] = useState<
    Record<
      string,
      { loading: boolean; ok?: boolean; message?: string }
    >
  >({});
  const [modelsMap, setModelsMap] = useState<
    Record<string, { loading: boolean; list: string[]; error?: string }>
  >({});

  const enabledServices = settings.services.filter((s) => s.enabled);
  const hasBilibiliIndexService = settings.services.some(
    (s) =>
      s.preset === 'bilibili-index' ||
      s.baseUrl.toLowerCase().includes('index-translate.bilibili.com'),
  );

  const updateSingleService = (
    id: string,
    patch: Partial<ServiceProfile>,
  ) => {
    patchSettings((prev) => ({
      ...prev,
      services: prev.services.map((s) =>
        s.id === id ? { ...s, ...patch } : s,
      ),
    }));
  };

  const handleAddService = async () => {
    const created = createServiceFromPreset(selectedPreset);
    await patchSettings((prev) => ({
      ...prev,
      services: [created, ...prev.services],
      primaryServiceId: prev.primaryServiceId || created.id,
    }));
  };

  const handleQuickAddBiliIndex = async () => {
    const created = createServiceFromPreset('bilibili-index');
    await patchSettings((prev) => ({
      ...prev,
      services: [created, ...prev.services],
      primaryServiceId: created.id,
    }));
  };

  const handleDeleteService = async (id: string) => {
    if (settings.services.length <= 1) return;
    await patchSettings((prev) => {
      const remaining = prev.services.filter((s) => s.id !== id);
      const firstRemaining = remaining[0];
      return {
        ...prev,
        services: remaining,
        primaryServiceId:
          prev.primaryServiceId === id && firstRemaining
            ? firstRemaining.id
            : prev.primaryServiceId,
        selectionServiceId:
          prev.selectionServiceId === id
            ? 'follow-primary'
            : prev.selectionServiceId,
      };
    });
  };

  const handleTestService = async (svc: ServiceProfile) => {
    setTestingMap((prev) => ({ ...prev, [svc.id]: { loading: true } }));
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TEST_SERVICE',
        service: svc,
      });
      if (res?.ok) {
        setTestingMap((prev) => ({
          ...prev,
          [svc.id]: {
            loading: false,
            ok: true,
            message: `连接成功 (${ res.latencyMs }ms) · 示例输出：「${ res.sampleOutput }」`,
          },
        }));
      } else {
        setTestingMap((prev) => ({
          ...prev,
          [svc.id]: {
            loading: false,
            ok: false,
            message: res?.error || '连接失败',
          },
        }));
      }
    } catch (err) {
      setTestingMap((prev) => ({
        ...prev,
        [svc.id]: {
          loading: false,
          ok: false,
          message: err instanceof Error ? err.message : '测试异常',
        },
      }));
    }
  };

  const handleFetchModels = async (svc: ServiceProfile) => {
    setModelsMap((prev) => ({
      ...prev,
      [svc.id]: { loading: true, list: prev[svc.id]?.list ?? [] },
    }));
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'FETCH_MODELS',
        baseUrl: svc.baseUrl,
        apiKey: svc.apiKey,
      });
      if (res?.ok && Array.isArray(res.models)) {
        setModelsMap((prev) => ({
          ...prev,
          [svc.id]: { loading: false, list: res.models },
        }));
        if (res.models.length > 0 && !res.models.includes(svc.model)) {
          updateSingleService(svc.id, { model: res.models[0] });
        }
      } else {
        setModelsMap((prev) => ({
          ...prev,
          [svc.id]: {
            loading: false,
            list: [],
            error: res?.error || '未拉取到模型列表',
          },
        }));
      }
    } catch (err) {
      setModelsMap((prev) => ({
        ...prev,
        [svc.id]: {
          loading: false,
          list: [],
          error: err instanceof Error ? err.message : '拉取失败',
        },
      }));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Global Routing & Language Card */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-base font-semibold">翻译路由与默认语言</h2>
        <p className="mb-4 text-xs text-slate-500 dark:text-zinc-400">
          默认全局使用主翻译服务，也可为「划词释义」或「视频字幕」单独指定响应更快或推理更强的专属模型。
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
              主翻译服务（整页 & 悬停）
            </label>
            <select
              value={settings.primaryServiceId}
              onChange={(e) =>
                patchSettings({ primaryServiceId: e.target.value })
              }
              className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              {enabledServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.model})
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
              划词释义服务
            </label>
            <select
              value={settings.selectionServiceId}
              onChange={(e) =>
                patchSettings({ selectionServiceId: e.target.value })
              }
              className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              <option value="follow-primary">跟随主翻译服务</option>
              {enabledServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.model})
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
              视频字幕服务（YT / B站）
            </label>
            <select
              value={settings.videoSubtitle.subtitleServiceId}
              onChange={(e) =>
                patchSettings((prev) => ({
                  ...prev,
                  videoSubtitle: {
                    ...prev.videoSubtitle,
                    subtitleServiceId: e.target.value,
                  },
                }))
              }
              className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              <option value="follow-primary">跟随主翻译服务</option>
              {enabledServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.model})
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
              源语言
            </label>
            <select
              value={settings.sourceLang}
              onChange={(e) =>
                patchSettings({ sourceLang: e.target.value as LanguageCode })
              }
              className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              {LANGUAGE_OPTIONS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
              目标语言
            </label>
            <select
              value={settings.targetLang}
              onChange={(e) =>
                patchSettings({
                  targetLang: e.target.value as TargetLanguageCode,
                })
              }
              className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              {LANGUAGE_OPTIONS.filter((l) => l.code !== 'auto').map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Hidden Experimental Video Timeline Prefetch Card (Unlocked after 20 taps in AboutTab) */}
      {settings.videoSubtitle.advancedTimelineUnlocked && (
        <section className="rounded-2xl border border-amber-300/70 bg-amber-50/40 p-5 shadow-2xs dark:border-amber-800/50 dark:bg-amber-950/20">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles size={15} className="text-amber-600 dark:text-amber-400" />
                <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
                  实验性增强 · 视频字幕时间轴主动预拉取
                </h3>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/60 dark:text-amber-300">
                  Hidden Feature
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-600 dark:text-zinc-400">
                关闭时采用「0 额外请求」纯前端被动伴随模式；开启后支持主动拉取 YouTube / Bilibili 完整字幕时间轴，实现提前窗口预译（0ms 上屏）与自动语音字幕智能断句。
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                patchSettings((prev) => ({
                  ...prev,
                  videoSubtitle: {
                    ...prev.videoSubtitle,
                    advancedTimelineUnlocked: false,
                    enableActiveTimelineFetch: false,
                  },
                }))
              }
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 transition hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              title="关闭并隐藏此实验配置卡片"
            >
              <Lock size={12} />
              隐藏并锁定
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-6 border-t border-amber-200/60 pt-3.5 text-xs dark:border-amber-900/40">
            <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-slate-800 dark:text-zinc-200">
              <input
                type="checkbox"
                checked={settings.videoSubtitle.enableActiveTimelineFetch}
                onChange={(e) =>
                  patchSettings((prev) => ({
                    ...prev,
                    videoSubtitle: {
                      ...prev.videoSubtitle,
                      enableActiveTimelineFetch: e.target.checked,
                    },
                  }))
                }
                className="h-4 w-4 rounded accent-blue-600"
              />
              <span>启用完整字幕时间轴主动预拉取与提前预译</span>
            </label>

            <label className="inline-flex cursor-pointer items-center gap-2 text-slate-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={settings.videoSubtitle.preferNativeBilingual}
                onChange={(e) =>
                  patchSettings((prev) => ({
                    ...prev,
                    videoSubtitle: {
                      ...prev.videoSubtitle,
                      preferNativeBilingual: e.target.checked,
                    },
                  }))
                }
                className="h-4 w-4 rounded accent-blue-600"
              />
              <span>B站已有外语+中文双轨时优先对齐原生字幕（免耗 Token）</span>
            </label>

            <div className="flex items-center gap-2 text-slate-700 dark:text-zinc-300">
              <span>前瞻预译窗口</span>
              <select
                value={settings.videoSubtitle.pretranslateSeconds}
                onChange={(e) =>
                  patchSettings((prev) => ({
                    ...prev,
                    videoSubtitle: {
                      ...prev.videoSubtitle,
                      pretranslateSeconds: Number(e.target.value) || 60,
                    },
                  }))
                }
                className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value={30}>提前 30 秒</option>
                <option value={60}>提前 60 秒（推荐）</option>
                <option value={90}>提前 90 秒</option>
              </select>
            </div>
          </div>
        </section>
      )}

      {/* Add Service Bar */}
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">添加模型或本地 Ollama 服务</div>
            <div className="text-xs text-slate-500 dark:text-zinc-400">
              本地 Ollama 与 Bilibili Index-Translate 均已内置动态请求头兼容，免配置跨域与终端代理直连。
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedPreset}
              onChange={(e) =>
                setSelectedPreset(e.target.value as ServicePresetType)
              }
              className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              {SERVICE_PRESETS.map((p) => (
                <option key={p.preset} value={p.preset}>
                  {p.preset === 'bilibili-index'
                    ? `${ p.label }（感谢阿B限时免费接口）`
                    : p.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAddService}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-semibold text-white shadow-xs transition hover:bg-blue-700"
            >
              <Plus size={14} /> 新增服务实例
            </button>
          </div>
        </div>

        {!hasBilibiliIndexService && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-pink-200/80 bg-pink-50/50 px-3.5 py-2.5 text-xs dark:border-pink-900/50 dark:bg-pink-950/20">
            <div className="flex flex-wrap items-center gap-2 text-slate-700 dark:text-zinc-300">
              <span className="rounded-full bg-pink-100 px-2.5 py-0.5 text-[11px] font-semibold text-pink-700 dark:bg-pink-900/60 dark:text-pink-300">
                感谢阿B限时免费接口
              </span>
              <span>
                免 API Key、无需本地 Python 代理，直连{' '}
                <code className="font-mono font-medium">Index-Translate-35B-A3B</code>{' '}
                / <code className="font-mono">9B</code> /{' '}
                <code className="font-mono">2B</code> 翻译大模型
              </span>
            </div>
            <button
              type="button"
              onClick={handleQuickAddBiliIndex}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-pink-600 px-3 text-xs font-semibold text-white transition hover:bg-pink-700"
            >
              <Plus size={12} /> 一键添加并设为主服务
            </button>
          </div>
        )}
      </div>

      {/* Service Cards */}
      <div className="flex flex-col gap-4">
        {settings.services.map((svc) => {
          const isPrimary = settings.primaryServiceId === svc.id;
          const isBiliIndex =
            svc.preset === 'bilibili-index' ||
            svc.baseUrl.toLowerCase().includes('index-translate.bilibili.com');
          const testState = testingMap[svc.id];
          const modelState = modelsMap[svc.id];
          const keyVisible = Boolean(visibleKeys[svc.id]);

          return (
            <div
              key={svc.id}
              className={`rounded-2xl border bg-white p-5 shadow-2xs transition dark:bg-zinc-900 ${
                isPrimary
                  ? 'border-blue-500/70 ring-1 ring-blue-500/20'
                  : 'border-slate-200 dark:border-zinc-800'
              }`}
            >
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={svc.name}
                    onChange={(e) =>
                      updateSingleService(svc.id, { name: e.target.value })
                    }
                    className="rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold hover:border-slate-200 focus:border-blue-500 focus:bg-slate-50 focus:outline-none dark:hover:border-zinc-700 dark:focus:bg-zinc-800"
                  />
                  {isBiliIndex && (
                    <span className="rounded-full bg-pink-50 px-2.5 py-0.5 text-[11px] font-semibold text-pink-600 dark:bg-pink-950/60 dark:text-pink-300">
                      感谢阿B限时免费接口
                    </span>
                  )}
                  {isPrimary && (
                    <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
                      当前主服务
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleTestService(svc)}
                    disabled={testState?.loading}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium transition hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {testState?.loading ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Zap size={13} className="text-amber-500" />
                    )}
                    测试连接
                  </button>

                  {!isPrimary && svc.enabled && (
                    <button
                      type="button"
                      onClick={() =>
                        patchSettings({ primaryServiceId: svc.id })
                      }
                      className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-medium text-blue-600 transition hover:bg-blue-50 dark:border-zinc-700 dark:text-blue-400 dark:hover:bg-blue-950/40"
                    >
                      设为主服务
                    </button>
                  )}

                  <label className="ml-1 inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-600 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={svc.enabled}
                      onChange={(e) =>
                        updateSingleService(svc.id, {
                          enabled: e.target.checked,
                        })
                      }
                      className="h-4 w-4 rounded accent-blue-600"
                    />
                    启用
                  </label>

                  {settings.services.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleDeleteService(svc.id)}
                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                      title="删除此服务配置"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>

              {isBiliIndex && (
                <div className="mb-4 rounded-xl border border-pink-100 bg-pink-50/40 px-3.5 py-2 text-xs text-slate-600 dark:border-pink-950/50 dark:bg-pink-950/15 dark:text-zinc-400">
                  免 API Key 浏览器直连（自动剥离扩展 Origin 与登录 Cookie 防止 412 拦截，并默认注入{' '}
                  <code className="font-mono">enable_thinking: false</code>
                  ）。可点击「拉取模型列表」切换{' '}
                  <code className="font-mono">Index-Translate-35B-A3B</code> /{' '}
                  <code className="font-mono">9B</code> /{' '}
                  <code className="font-mono">2B</code>，亦支持改填本地{' '}
                  <code className="font-mono">vLLM / call_api.py --serve</code> 地址。
                </div>
              )}

              {testState?.message && (
                <div
                  className={`mb-4 flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs ${
                    testState.ok
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                      : 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300'
                  }`}
                >
                  {testState.ok && <CheckCircle2 size={14} />}
                  <span>{testState.message}</span>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
                    接口地址 (Base URL)
                  </label>
                  <input
                    type="text"
                    value={svc.baseUrl}
                    placeholder="https://api.openai.com/v1"
                    onChange={(e) =>
                      updateSingleService(svc.id, { baseUrl: e.target.value })
                    }
                    className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
                    {isBiliIndex
                      ? 'API Key（感谢阿B限时免费接口，留空直连）'
                      : 'API Key（本地 Ollama 可留空）'}
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={keyVisible ? 'text' : 'password'}
                      value={svc.apiKey}
                      placeholder={
                        svc.preset === 'ollama'
                          ? '本地服务无需填写'
                          : isBiliIndex
                            ? '限时免费公共接口无需填写（自建网关可填）'
                            : svc.preset === 'xiaomi-mimo-token-plan'
                              ? 'tp-... / sk-...'
                              : 'sk-...'
                      }
                      onChange={(e) =>
                        updateSingleService(svc.id, { apiKey: e.target.value })
                      }
                      className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pr-8 pl-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setVisibleKeys((prev) => ({
                          ...prev,
                          [svc.id]: !prev[svc.id],
                        }))
                      }
                      className="absolute right-2 text-slate-400 hover:text-slate-600"
                    >
                      {keyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">
                      模型名称 (Model)
                    </label>
                    <button
                      type="button"
                      onClick={() => handleFetchModels(svc)}
                      disabled={modelState?.loading}
                      className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
                    >
                      <RefreshCw
                        size={11}
                        className={modelState?.loading ? 'animate-spin' : ''}
                      />
                      拉取模型列表
                    </button>
                  </div>

                  {modelState?.list && modelState.list.length > 0 ? (
                    <div className="flex gap-1.5">
                      <select
                        value={svc.model}
                        onChange={(e) =>
                          updateSingleService(svc.id, { model: e.target.value })
                        }
                        className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                      >
                        {!modelState.list.includes(svc.model) && svc.model && (
                          <option value={svc.model}>{svc.model}</option>
                        )}
                        {modelState.list.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={svc.model}
                      placeholder="如 gpt-4o-mini / MiniMax-M2.5 / mimo-v2.6-flash / kimi-for-coding / qwen2.5:7b"
                      onChange={(e) =>
                        updateSingleService(svc.id, { model: e.target.value })
                      }
                      className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                    />
                  )}
                  {modelState?.error && (
                    <span className="text-[11px] text-red-500">
                      {modelState.error}
                    </span>
                  )}
                </div>
              </div>

              {/* Per-Service Glossary Mount & Advanced Controls */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-3.5 text-xs dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-5">
                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={svc.enableGlossary}
                      onChange={(e) =>
                        updateSingleService(svc.id, {
                          enableGlossary: e.target.checked,
                        })
                      }
                      className="h-4 w-4 rounded accent-blue-600"
                    />
                    <span>挂载全局术语表（按段动态命中注入）</span>
                  </label>

                  <label className="inline-flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={svc.suppressThinking}
                      onChange={(e) =>
                        updateSingleService(svc.id, {
                          suppressThinking: e.target.checked,
                        })
                      }
                      className="h-4 w-4 rounded accent-blue-600"
                    />
                    <span>抑制推理模型思考链（降低延迟）</span>
                  </label>
                </div>

                <div className="flex items-center gap-4 text-slate-500 dark:text-zinc-400">
                  <label className="inline-flex items-center gap-1.5">
                    <span>聚合段数</span>
                    <input
                      type="number"
                      min={1}
                      max={15}
                      value={svc.batchSize}
                      onChange={(e) =>
                        updateSingleService(svc.id, {
                          batchSize: Math.max(
                            1,
                            Math.min(15, Number(e.target.value) || 6),
                          ),
                        })
                      }
                      className="h-7 w-14 rounded-md border border-slate-200 bg-slate-50 px-2 text-center text-xs dark:border-zinc-700 dark:bg-zinc-800"
                    />
                  </label>

                  <label className="inline-flex items-center gap-1.5">
                    <span>并发数</span>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={svc.maxConcurrency}
                      onChange={(e) =>
                        updateSingleService(svc.id, {
                          maxConcurrency: Math.max(
                            1,
                            Math.min(12, Number(e.target.value) || 4),
                          ),
                        })
                      }
                      className="h-7 w-14 rounded-md border border-slate-200 bg-slate-50 px-2 text-center text-xs dark:border-zinc-700 dark:bg-zinc-800"
                    />
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
