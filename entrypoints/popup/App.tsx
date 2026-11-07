import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  ExternalLink,
  Globe,
  Languages,
  Settings,
  Sparkles,
} from 'lucide-react';
import {
  LANGUAGE_OPTIONS,
  matchSiteRule,
  resolvePrimaryService,
  STYLE_PRESET_OPTIONS,
} from '../../src/storage';
import { useSettings } from '../../src/storage/useSettings';
import { formatShortcutLabel } from '../../src/shortcuts';
import type {
  PageTabState,
  PageViewMode,
  TargetLanguageCode,
} from '../../src/types';
import { isGitHubCodeHost } from '../content/dom/github-comments';

export const App: React.FC = () => {
  const { settings, loading, patchSettings } = useSettings();
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [hostname, setHostname] = useState<string>('');
  const [restrictedPage, setRestrictedPage] = useState(false);
  const [tabState, setTabState] = useState<PageTabState>({
    mode: 'original',
    hostname: '',
    translatedCount: 0,
    inFlightCount: 0,
  });

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id || !tab.url) {
        setRestrictedPage(true);
        return;
      }
      try {
        const u = new URL(tab.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') {
          setRestrictedPage(true);
          return;
        }
        setHostname(u.hostname);
      } catch {
        setRestrictedPage(true);
        return;
      }

      setActiveTabId(tab.id);
      chrome.tabs
        .sendMessage(tab.id, { type: 'GET_TAB_STATE' })
        .then((res: PageTabState | undefined) => {
          if (res) setTabState(res);
        })
        .catch(() => {
          // Content script might require page refresh on tabs opened prior to extension install
        });
    });
  }, []);

  const switchMode = async (mode: PageViewMode) => {
    if (!activeTabId) return;
    setTabState((prev) => ({ ...prev, mode }));
    try {
      const res: PageTabState | undefined = await chrome.tabs.sendMessage(
        activeTabId,
        { type: 'SET_TAB_VIEW_MODE', mode },
      );
      if (res) setTabState(res);
    } catch {
      // Ignore if tab hasn't reloaded after install
    }
  };

  const openOptions = (section?: string) => {
    const url = chrome.runtime.getURL(
      section ? `/options.html#${ section }` : '/options.html',
    );
    chrome.tabs.create({ url });
    window.close();
  };

  if (loading) {
    return <div className="p-5 text-xs text-slate-400">加载中…</div>;
  }

  const enabledServices = settings.services.filter((s) => s.enabled);
  const activeService = resolvePrimaryService(settings);
  const currentRule = hostname
    ? matchSiteRule(hostname, settings.siteRules)
    : undefined;
  const targetLangOptions = LANGUAGE_OPTIONS.filter((l) => l.code !== 'auto');
  const isGitHub = hostname ? isGitHubCodeHost(hostname) : false;

  const toggleDomainAuto = async () => {
    if (!hostname) return;
    const nextAction =
      currentRule?.action === 'always-bilingual' ? 'none' : 'always-bilingual';

    await patchSettings((prev) => {
      const idx = prev.siteRules.findIndex((r) => r.pattern === hostname);
      if (idx >= 0) {
        return {
          ...prev,
          siteRules: prev.siteRules.map((r, i) =>
            i === idx ? { ...r, action: nextAction, enabled: true } : r,
          ),
        };
      }
      return {
        ...prev,
        siteRules: [
          {
            id: `rule_${ Date.now() }`,
            pattern: hostname,
            action: nextAction,
            hideFloatingTab: false,
            enabled: true,
          },
          ...prev.siteRules,
        ],
      };
    });
  };

  const toggleDomainNever = async () => {
    if (!hostname) return;
    const nextAction =
      currentRule?.action === 'never-translate' ? 'none' : 'never-translate';

    await patchSettings((prev) => {
      const idx = prev.siteRules.findIndex((r) => r.pattern === hostname);
      if (idx >= 0) {
        return {
          ...prev,
          siteRules: prev.siteRules.map((r, i) =>
            i === idx ? { ...r, action: nextAction, enabled: true } : r,
          ),
        };
      }
      return {
        ...prev,
        siteRules: [
          {
            id: `rule_${ Date.now() }`,
            pattern: hostname,
            action: nextAction,
            hideFloatingTab: false,
            enabled: true,
          },
          ...prev.siteRules,
        ],
      };
    });
    if (nextAction === 'never-translate') {
      setTabState((prev) => ({ ...prev, mode: 'original' }));
    }
  };

  const toggleDomainFloatingTab = async () => {
    if (!hostname) return;
    const nextHide = !currentRule?.hideFloatingTab;

    await patchSettings((prev) => {
      const idx = prev.siteRules.findIndex((r) => r.pattern === hostname);
      if (idx >= 0) {
        return {
          ...prev,
          siteRules: prev.siteRules.map((r, i) =>
            i === idx ? { ...r, hideFloatingTab: nextHide, enabled: true } : r,
          ),
        };
      }
      return {
        ...prev,
        siteRules: [
          {
            id: `rule_${ Date.now() }`,
            pattern: hostname,
            action: 'none',
            hideFloatingTab: nextHide,
            enabled: true,
          },
          ...prev.siteRules,
        ],
      };
    });
  };

  return (
    <div className="flex flex-col gap-3.5 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img
            src="/icon/128.png"
            alt="Bo Translation"
            className="h-7 w-7 shrink-0 select-none"
          />
          <div>
            <div className="text-sm font-semibold leading-tight">
              Bo Translation
            </div>
            <div className="text-[11px] text-slate-500 dark:text-zinc-400">
              快捷键 {formatShortcutLabel(settings.shortcuts.toggleBilingual)} 切换双语
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => openOptions()}
          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-200/70 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          title="打开完整设置中心"
        >
          <Settings size={16} />
        </button>
      </div>

      {/* Three-State View Switcher */}
      {restrictedPage ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          当前标签页为浏览器受限页面，请打开普通外语文章或技术文档体验双语对照。
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200/80 bg-white p-1.5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                ['original', '原文'],
                ['bilingual', '双语对照'],
                ['translated-only', '仅看译文'],
              ] as const
            ).map(([val, label]) => {
              const active = tabState.mode === val;
              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => switchMode(val)}
                  className={`rounded-lg py-1.5 text-xs font-medium transition ${
                    active
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Primary Service & Target Language */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-slate-200/80 bg-white p-3 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-zinc-400">
            <span className="flex items-center gap-1">
              <Sparkles size={12} /> 主翻译服务
            </span>
            <button
              type="button"
              onClick={() => openOptions('services')}
              className="inline-flex items-center gap-0.5 text-blue-600 hover:underline dark:text-blue-400"
            >
              配置密钥/模型 <ExternalLink size={10} />
            </button>
          </div>
          <select
            value={activeService.id}
            onChange={(e) => patchSettings({ primaryServiceId: e.target.value })}
            className="h-8 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
          >
            {enabledServices.map((svc) => (
              <option key={svc.id} value={svc.id}>
                {svc.name} · {svc.model}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400">
              <Languages size={12} /> 目标语言
            </span>
            <select
              value={settings.targetLang}
              onChange={(e) =>
                patchSettings({
                  targetLang: e.target.value as TargetLanguageCode,
                })
              }
              className="h-8 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              {targetLangOptions.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">
              译文样式
            </span>
            <select
              value={settings.stylePreset}
              onChange={(e) =>
                patchSettings({
                  stylePreset: e.target.value as typeof settings.stylePreset,
                })
              }
              className="h-8 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            >
              {STYLE_PRESET_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Domain & Smart Auto Rules */}
      {hostname && !restrictedPage && (
        <div className="flex flex-col gap-2 rounded-xl border border-slate-200/80 bg-white p-3 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-slate-500 dark:text-zinc-400">
            <span className="flex items-center gap-1.5 truncate">
              <Globe size={12} />
              <span className="truncate">{hostname}</span>
            </span>
            <button
              type="button"
              onClick={toggleDomainNever}
              className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                currentRule?.action === 'never-translate'
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-300'
              }`}
              title="将当前域名加入免译名单，智能外语自动翻译将跳过此站"
            >
              {currentRule?.action === 'never-translate'
                ? '✓ 此站已免译'
                : '此站免译'}
            </button>
          </div>

          <label className="flex cursor-pointer items-center justify-between text-xs">
            <span>智能识别外语网页自动双语</span>
            <input
              type="checkbox"
              checked={settings.autoTranslateForeignPages}
              onChange={(e) =>
                patchSettings({ autoTranslateForeignPages: e.target.checked })
              }
              className="h-4 w-4 rounded accent-blue-600"
            />
          </label>

          <label className="flex cursor-pointer items-center justify-between text-xs">
            <span>总是自动翻译此域名</span>
            <input
              type="checkbox"
              checked={currentRule?.action === 'always-bilingual'}
              onChange={toggleDomainAuto}
              className="h-4 w-4 rounded accent-blue-600"
            />
          </label>

          {isGitHub && (
            <label className="flex cursor-pointer items-center justify-between text-xs">
              <span>翻译 GitHub 代码行内注释</span>
              <input
                type="checkbox"
                checked={settings.enableGithubCommentTranslation}
                onChange={(e) =>
                  patchSettings({
                    enableGithubCommentTranslation: e.target.checked,
                  })
                }
                className="h-4 w-4 rounded accent-blue-600"
              />
            </label>
          )}

          <label className="flex cursor-pointer items-center justify-between text-xs">
            <span>在此网站显示侧边快捷签</span>
            <input
              type="checkbox"
              checked={
                settings.floatingTab.enabled && !currentRule?.hideFloatingTab
              }
              onChange={toggleDomainFloatingTab}
              className="h-4 w-4 rounded accent-blue-600"
            />
          </label>
        </div>
      )}

      {/* Footer Quick Link to Glossary */}
      <div className="flex items-center justify-between px-0.5 text-[11px] text-slate-500 dark:text-zinc-400">
        <button
          type="button"
          onClick={() => openOptions('glossary')}
          className="inline-flex items-center gap-1 hover:text-blue-600 dark:hover:text-blue-400"
        >
          <BookOpen size={12} />
          术语库（已配 {settings.glossary.filter((g) => g.enabled).length} 条）
        </button>
        <button
          type="button"
          onClick={() => openOptions('shortcuts')}
          className="hover:text-blue-600 dark:hover:text-blue-400"
        >
          自定义快捷键 →
        </button>
      </div>
    </div>
  );
};
