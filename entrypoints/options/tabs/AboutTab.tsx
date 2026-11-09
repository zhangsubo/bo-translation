import React, { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  LockOpen,
  ShieldCheck,
  Sparkles,
  Subtitles,
} from 'lucide-react';
import { VersionTapUnlocker } from '../../../src/subtitle/unlock';
import type { ExtensionSettings } from '../../../src/types';

interface AboutTabProps {
  settings: ExtensionSettings;
  patchSettings: (
    patch:
      | Partial<ExtensionSettings>
      | ((prev: ExtensionSettings) => ExtensionSettings),
  ) => Promise<ExtensionSettings>;
  onNavigateServices: () => void;
}

export const AboutTab: React.FC<AboutTabProps> = ({
  settings,
  patchSettings,
  onNavigateServices,
}) => {
  const unlockerRef = useRef<VersionTapUnlocker>(
    new VersionTapUnlocker({
      requiredTaps: 20,
      resetTimeoutMs: 2500,
      hintThreshold: 15,
    }),
  );

  const [hintText, setHintText] = useState<string>('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const version = useMemo(() => {
    try {
      return chrome?.runtime?.getManifest?.()?.version || '0.2.0';
    } catch {
      return '0.2.0';
    }
  }, []);

  const isUnlocked = settings.videoSubtitle.advancedTimelineUnlocked;

  const handleVersionClick = () => {
    if (isUnlocked) {
      setHintText('实验性视频字幕时间轴配置已解锁，可在「模型与服务配置」中管理。');
      return;
    }

    const step = unlockerRef.current.tap();
    if (step.state === 'hint') {
      setHintText(
        `再连续点击 ${ step.remaining } 次版本号，即可解锁视频字幕增强配置…`,
      );
    } else if (step.state === 'ready') {
      setHintText('');
      setConfirmOpen(true);
    } else {
      setHintText('');
    }
  };

  const handleConfirmUnlock = async () => {
    await patchSettings((prev) => ({
      ...prev,
      videoSubtitle: {
        ...prev.videoSubtitle,
        advancedTimelineUnlocked: true,
        enableActiveTimelineFetch: true,
      },
    }));
    setConfirmOpen(false);
    setHintText('');
    onNavigateServices();
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Hero About Card */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <img
              src="/icon/128.png"
              alt="Bo Translation"
              className="h-12 w-12 shrink-0 select-none"
            />
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-lg font-bold tracking-tight">
                  Bo Translation
                </h2>
                <button
                  type="button"
                  onClick={handleVersionClick}
                  title="当前扩展版本"
                  className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-0.5 font-mono text-xs font-medium text-slate-600 transition active:scale-95 hover:border-blue-300 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  <span>v{version}</span>
                </button>
                {isUnlocked && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                    <Sparkles size={11} />
                    已解锁字幕增强项
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                围绕同一次阅读与观看展开的 Chrome 沉浸式双语对照插件
              </p>
            </div>
          </div>
        </div>

        {hintText && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-blue-200/70 bg-blue-50/70 px-3.5 py-2 text-xs text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300">
            <Sparkles size={13} className="shrink-0" />
            <span>{hintText}</span>
          </div>
        )}

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/50">
            <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-zinc-200">
              <Sparkles size={14} className="text-blue-600" />
              读到哪里，对照到哪里
            </div>
            <p className="text-xs leading-relaxed text-slate-500 dark:text-zinc-400">
              视口按需懒加载与聚合流式输出，支持技术文档行内代码原子硬锁、悬停单段对照、上下文划词释义与一键存为术语。
            </p>
          </div>

          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/50">
            <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-zinc-200">
              <Subtitles size={14} className="text-emerald-600" />
              视频伴随双语字幕
            </div>
            <p className="text-xs leading-relaxed text-slate-500 dark:text-zinc-400">
              支持在 YouTube 与 Bilibili 播放器内开启实时双语字幕对照，悬停字幕自动暂停并联动上下文划词查义。
            </p>
          </div>

          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/50">
            <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-zinc-200">
              <ShieldCheck size={14} className="text-indigo-600" />
              纯本地隐私架构
            </div>
            <p className="text-xs leading-relaxed text-slate-500 dark:text-zinc-400">
              零自建后端、零账号追踪。所有配置与密钥仅保存在浏览器本地存储，支持直连本机 Ollama 模型实现数据不出本机。
            </p>
          </div>
        </div>
      </section>

      {/* Architecture & Runtime Summary */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Cpu size={15} className="text-slate-500" />
          <span>运行信息与使用提示</span>
        </div>
        <ul className="space-y-2 text-xs leading-relaxed text-slate-600 dark:text-zinc-400">
          <li className="flex items-center gap-2">
            <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
            <span>
              当前已启用服务数：{settings.services.filter((s) => s.enabled).length} 个 · 全局术语条目：{settings.glossary.length} 条
            </span>
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
            <span>
              在 YouTube 或 Bilibili 播放页开启原文字幕后，点击播放器右下角控制栏中的「双语」按钮即可开启视频双语字幕对照。
            </span>
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
            <span>
              构建产物目录固定位于项目根下的 <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">dist/chrome-mv3</code>。
            </span>
          </li>
        </ul>
      </section>

      {/* 20-Tap Unlock Confirmation Modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="mb-2 flex items-center gap-2.5 text-base font-bold text-slate-900 dark:text-zinc-100">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400">
                <LockOpen size={16} />
              </div>
              <span>开启隐藏功能：字幕时间轴主动预拉取？</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-zinc-400">
              你已连续点击版本号 20 次。开启后将在「模型与服务配置」页解锁实验性的
              <strong className="font-semibold text-slate-800 dark:text-zinc-200">
                「视频字幕时间轴主动预拉取」
              </strong>
              开关，支持在 YouTube 与 Bilibili 主动加载完整字幕时间轴，实现提前预译与 ASR 自动断句优化。
            </p>
            <div className="mt-5 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="h-9 rounded-xl border border-slate-200 px-4 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                暂不开启
              </button>
              <button
                type="button"
                onClick={handleConfirmUnlock}
                className="h-9 rounded-xl bg-blue-600 px-4 text-xs font-semibold text-white shadow-xs transition hover:bg-blue-700"
              >
                确认开启并前往服务配置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
