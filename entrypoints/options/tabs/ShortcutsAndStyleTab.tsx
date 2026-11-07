import React, { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  DEFAULT_SETTINGS,
  STYLE_PRESET_OPTIONS,
} from '../../../src/storage';
import {
  detectShortcutConflicts,
  formatShortcutLabel,
  serializeKeyboardEvent,
} from '../../../src/shortcuts';
import type {
  ExtensionSettings,
  HoverModifierKey,
  ShortcutConfig,
} from '../../../src/types';

interface ShortcutsAndStyleTabProps {
  settings: ExtensionSettings;
  patchSettings: (
    updater:
      | Partial<ExtensionSettings>
      | ((prev: ExtensionSettings) => ExtensionSettings),
  ) => Promise<ExtensionSettings>;
}

const SHORTCUT_ITEMS: Array<{
  key: 'toggleBilingual' | 'toggleTranslatedOnly' | 'selectionLookup' | 'retranslateParagraph';
  title: string;
  desc: string;
}> = [
  {
    key: 'toggleBilingual',
    title: '切换整页双语 / 恢复原文',
    desc: '开启或关闭当前网页的视口按需双语对照',
  },
  {
    key: 'toggleTranslatedOnly',
    title: '切换「仅看译文」与「双语对照」',
    desc: '隐藏原文专注阅读译文，或立即恢复上下对照',
  },
  {
    key: 'selectionLookup',
    title: '查看选中文字上下文释义',
    desc: '选中单词或长句后直接唤起语境词解/翻译浮层',
  },
  {
    key: 'retranslateParagraph',
    title: '单段重新翻译',
    desc: '对当前鼠标悬停所在的段落绕过缓存重新翻译',
  },
];

export const ShortcutsAndStyleTab: React.FC<ShortcutsAndStyleTabProps> = ({
  settings,
  patchSettings,
}) => {
  const [recordingKey, setRecordingKey] = useState<
    keyof ShortcutConfig | null
  >(null);

  const conflicts = detectShortcutConflicts(settings.shortcuts);

  const handleRecordKeyDown = (
    field: keyof ShortcutConfig,
    e: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecordingKey(null);
      return;
    }
    const serialized = serializeKeyboardEvent(e.nativeEvent);
    if (!serialized) return;

    patchSettings((prev) => ({
      ...prev,
      shortcuts: {
        ...prev.shortcuts,
        [field]: serialized,
      },
    }));
    setRecordingKey(null);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Keyboard Shortcuts Recorder */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">自定义键盘快捷键</h2>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              点击右侧按键框后直接按下组合键即可录制（兼容 macOS Option 组合键，按 Esc 取消）。
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              patchSettings({ shortcuts: DEFAULT_SETTINGS.shortcuts })
            }
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            <RotateCcw size={13} /> 恢复默认快捷键
          </button>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-zinc-800">
          {SHORTCUT_ITEMS.map((item) => {
            const isRecording = recordingKey === item.key;
            const binding = settings.shortcuts[item.key];
            const conflictMsg = conflicts[item.key];

            return (
              <div
                key={item.key}
                className="flex flex-wrap items-center justify-between gap-3 py-3.5"
              >
                <div>
                  <div className="text-xs font-semibold">{item.title}</div>
                  <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                    {item.desc}
                  </div>
                  {conflictMsg && (
                    <div className="mt-1 text-[11px] font-medium text-red-500">
                      ⚠ {conflictMsg}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setRecordingKey(item.key)}
                  onBlur={() => setRecordingKey(null)}
                  onKeyDown={(e) => {
                    if (isRecording) handleRecordKeyDown(item.key, e);
                  }}
                  className={`h-9 min-w-[132px] rounded-lg border px-3.5 font-mono text-xs font-semibold transition ${
                    isRecording
                      ? 'border-blue-600 bg-blue-50 text-blue-600 ring-2 ring-blue-500/20 dark:bg-blue-950/60 dark:text-blue-300'
                      : conflictMsg
                        ? 'border-red-400 bg-red-50 text-red-600'
                        : 'border-slate-200 bg-slate-50 hover:border-slate-300 dark:border-zinc-700 dark:bg-zinc-800'
                  }`}
                >
                  {isRecording
                    ? '请按下组合键…'
                    : formatShortcutLabel(binding)}
                </button>
              </div>
            );
          })}
        </div>

        {/* Hover & Floating Tab Controls */}
        <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2 dark:border-zinc-800">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold">
              悬停单段翻译（及仅译文态偷看原文）修饰键
            </label>
            <select
              value={settings.shortcuts.hoverModifier}
              onChange={(e) =>
                patchSettings((prev) => ({
                  ...prev,
                  shortcuts: {
                    ...prev.shortcuts,
                    hoverModifier: e.target.value as HoverModifierKey,
                  },
                }))
              }
              className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              <option value="Alt">按住 Alt / Option 悬停段落</option>
              <option value="Control">按住 Control 悬停段落</option>
              <option value="Shift">按住 Shift 悬停段落</option>
              <option value="Meta">按住 Command / Win 悬停段落</option>
              <option value="None">禁用修饰键悬停触发</option>
            </select>
          </div>

          <div className="flex flex-col justify-center gap-2.5 pt-1 text-xs">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={settings.shortcuts.enableMouseHoldHover}
                onChange={(e) =>
                  patchSettings((prev) => ({
                    ...prev,
                    shortcuts: {
                      ...prev.shortcuts,
                      enableMouseHoldHover: e.target.checked,
                    },
                  }))
                }
                className="h-4 w-4 rounded accent-blue-600"
              />
              <span>启用「鼠标左键原地长按 600ms」触发单段双语</span>
            </label>

            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={settings.floatingTab.enabled}
                onChange={(e) =>
                  patchSettings((prev) => ({
                    ...prev,
                    floatingTab: {
                      ...prev.floatingTab,
                      enabled: e.target.checked,
                    },
                  }))
                }
                className="h-4 w-4 rounded accent-blue-600"
              />
              <span>显示页面边缘悬浮快捷签（支持上下拖拽）</span>
            </label>

            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={settings.showSelectionTriggerIcon}
                onChange={(e) =>
                  patchSettings({ showSelectionTriggerIcon: e.target.checked })
                }
                className="h-4 w-4 rounded accent-blue-600"
              />
              <span>划选文字后在光标旁显示「译」快捷小图标</span>
            </label>
          </div>
        </div>
      </section>

      {/* Translation Style & Live Preview */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">译文视觉样式与字号比例</h2>
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              调整后在所有已打开网页中实时生效，无需重新发起翻译请求。
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">译文字号缩放</span>
            <input
              type="range"
              min={0.85}
              max={1.15}
              step={0.02}
              value={settings.fontScale}
              onChange={(e) =>
                patchSettings({ fontScale: Number(e.target.value) })
              }
              className="w-28 accent-blue-600"
            />
            <span className="w-11 font-mono font-semibold">
              {Math.round(settings.fontScale * 100)}%
            </span>
          </div>
        </div>

        {/* Adaptive Contrast Color Mode */}
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          {(
            [
              {
                value: 'adaptive',
                title: '双色智能提亮 / 压暗（推荐）',
                desc: '自动采样网页暗色或亮色背景并计算对比度（WCAG ≥ 4.6:1），区分原文与译文层次且不刺眼',
              },
              {
                value: 'inherit',
                title: '原色对照',
                desc: '完全继承所在段落的原生文字颜色，适合追求极简同色排版的站点',
              },
            ] as const
          ).map((modeOpt) => {
            const active = settings.colorMode === modeOpt.value;
            return (
              <button
                key={modeOpt.value}
                type="button"
                onClick={() => patchSettings({ colorMode: modeOpt.value })}
                className={`flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition ${
                  active
                    ? 'border-blue-600 bg-blue-50/60 ring-1 ring-blue-600/20 dark:bg-blue-950/30'
                    : 'border-slate-200 hover:bg-slate-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60'
                }`}
              >
                <span className="text-xs font-semibold">{modeOpt.title}</span>
                <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                  {modeOpt.desc}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          {STYLE_PRESET_OPTIONS.map((opt) => {
            const active = settings.stylePreset === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => patchSettings({ stylePreset: opt.value })}
                className={`flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition ${
                  active
                    ? 'border-blue-600 bg-blue-50/60 ring-1 ring-blue-600/20 dark:bg-blue-950/30'
                    : 'border-slate-200 hover:bg-slate-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60'
                }`}
              >
                <span className="text-xs font-semibold">{opt.label}</span>
                <span className="text-[11px] text-slate-500 dark:text-zinc-400">
                  {opt.description}
                </span>
              </button>
            );
          })}
        </div>

        {/* Live Bilingual Preview Box */}
        <div className="rounded-xl border border-slate-200/90 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
          <div className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            实时双语排版预览
          </div>
          <p className="text-sm leading-relaxed text-slate-800 dark:text-zinc-200">
            React uses{' '}
            <code className="rounded bg-slate-200/80 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
              hydration
            </code>{' '}
            to attach event listeners to existing server-rendered HTML nodes without recreating the DOM tree.
          </p>

          <div
            style={{ fontSize: `${ settings.fontScale * 14 }px` }}
            className={`mt-2 leading-relaxed transition ${
              settings.colorMode === 'adaptive'
                ? 'text-sky-900 dark:text-sky-300'
                : 'text-slate-800 dark:text-zinc-200'
            } ${
              settings.stylePreset === 'blockquote'
                ? 'rounded-r-md border-l-[3px] border-blue-500 bg-blue-500/[0.06] px-3 py-1.5'
                : settings.stylePreset === 'muted'
                  ? 'opacity-72'
                  : settings.stylePreset === 'dashed'
                    ? 'underline decoration-blue-500/70 decoration-dashed underline-offset-4'
                    : settings.stylePreset === 'marker'
                      ? 'inline bg-gradient-to-t from-amber-300/30 from-40% to-transparent to-40%'
                      : settings.stylePreset === 'mask'
                        ? 'cursor-pointer blur-[4px] hover:blur-none'
                        : ''
            }`}
          >
            React 使用{' '}
            <code className="rounded bg-slate-200/80 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
              hydration
            </code>{' '}
            （水合）将事件监听器挂载到已由服务端渲染的 HTML 节点上，而无需重新创建 DOM 树。
          </div>
        </div>
      </section>
    </div>
  );
};
