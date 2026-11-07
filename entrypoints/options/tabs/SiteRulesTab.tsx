import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  ExtensionSettings,
  SiteRule,
  SiteRuleAction,
} from '../../../src/types';

interface SiteRulesTabProps {
  settings: ExtensionSettings;
  patchSettings: (
    updater:
      | Partial<ExtensionSettings>
      | ((prev: ExtensionSettings) => ExtensionSettings),
  ) => Promise<ExtensionSettings>;
}

export const SiteRulesTab: React.FC<SiteRulesTabProps> = ({
  settings,
  patchSettings,
}) => {
  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState<SiteRuleAction>('always-bilingual');
  const [hideFloatingTab, setHideFloatingTab] = useState(false);
  const [customSelectors, setCustomSelectors] = useState('');

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = pattern.trim().toLowerCase();
    if (!clean) return;

    const newRule: SiteRule = {
      id: `rule_${ Date.now() }_${ Math.random().toString(36).slice(2, 6) }`,
      pattern: clean,
      action,
      hideFloatingTab,
      customSelectors: customSelectors.trim() || undefined,
      enabled: true,
    };

    await patchSettings((prev) => ({
      ...prev,
      siteRules: [
        newRule,
        ...prev.siteRules.filter((r) => r.pattern.toLowerCase() !== clean),
      ],
    }));

    setPattern('');
    setCustomSelectors('');
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-base font-semibold">智能外语感知与代码阅读增强</h2>
        <p className="mb-4 text-xs text-slate-500 dark:text-zinc-400">
          基于浏览器本地离线语言检测与语法高亮节点识别，零额外网络探测请求。
        </p>

        <div className="divide-y divide-slate-100 dark:divide-zinc-800">
          <label className="flex cursor-pointer items-center justify-between gap-4 py-3">
            <div>
              <div className="text-xs font-semibold">
                智能识别外语网页并自动开启双语对照
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-zinc-400">
                自动跳过母语页面；后台未激活标签页懒启动（切回前台时再开始翻译）；同一 URL 手动切回「原文」后不再重复打扰。
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.autoTranslateForeignPages}
              onChange={(e) =>
                patchSettings({ autoTranslateForeignPages: e.target.checked })
              }
              className="h-4 w-4 shrink-0 rounded accent-blue-600"
            />
          </label>

          <label className="flex cursor-pointer items-center justify-between gap-4 py-3">
            <div>
              <div className="text-xs font-semibold">
                GitHub 代码阅读视图行内注释翻译
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-zinc-400">
                在 <code className="font-mono">github.com</code> /{' '}
                <code className="font-mono">gist.github.com</code>{' '}
                查看源码或 Diff 时翻译 <code className="font-mono">.pl-c</code>{' '}
                自然语言注释，自动过滤被注释掉的代码与 Linter 指令，严格保持左侧行号 1:1 对齐。
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.enableGithubCommentTranslation}
              onChange={(e) =>
                patchSettings({
                  enableGithubCommentTranslation: e.target.checked,
                })
              }
              className="h-4 w-4 shrink-0 rounded accent-blue-600"
            />
          </label>
        </div>
      </section>

      <form
        onSubmit={handleAddRule}
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 className="mb-1 text-base font-semibold">站点自动规则与高级选择器</h2>
        <p className="mb-4 text-xs text-slate-500 dark:text-zinc-400">
          支持精确域名（如 <code className="font-mono">docs.rs</code>）或通配子域名（如{' '}
          <code className="font-mono">*.react.dev</code>）。插件已内置 GitHub、Hacker News、StackOverflow、MDN 的精准正文识别规则。
        </p>

        <div className="grid gap-3 sm:grid-cols-12">
          <input
            type="text"
            placeholder="域名或通配符，如 *.react.dev"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 sm:col-span-3 dark:border-zinc-700 dark:bg-zinc-800"
          />

          <select
            value={action}
            onChange={(e) => setAction(e.target.value as SiteRuleAction)}
            className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs outline-none focus:border-blue-500 sm:col-span-3 dark:border-zinc-700 dark:bg-zinc-800"
          >
            <option value="always-bilingual">总是自动双语对照</option>
            <option value="always-translated-only">总是自动仅看译文</option>
            <option value="never-translate">不自动翻译</option>
            <option value="none">默认手动触发</option>
          </select>

          <input
            type="text"
            placeholder="可选自定义目标 CSS 选择器（如 article p）"
            value={customSelectors}
            onChange={(e) => setCustomSelectors(e.target.value)}
            className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 sm:col-span-3 dark:border-zinc-700 dark:bg-zinc-800"
          />

          <div className="flex items-center justify-between gap-2 sm:col-span-3">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={hideFloatingTab}
                onChange={(e) => setHideFloatingTab(e.target.checked)}
                className="h-4 w-4 rounded accent-blue-600"
              />
              隐藏悬浮签
            </label>
            <button
              type="submit"
              className="inline-flex h-9 items-center gap-1 rounded-lg bg-blue-600 px-3.5 text-xs font-semibold text-white hover:bg-blue-700"
            >
              <Plus size={14} /> 添加规则
            </button>
          </div>
        </div>
      </form>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        {settings.siteRules.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            暂无自定义站点规则
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="pb-2.5 font-medium">启用</th>
                  <th className="pb-2.5 font-medium">匹配域名</th>
                  <th className="pb-2.5 font-medium">自动行为</th>
                  <th className="pb-2.5 font-medium">侧边快捷签</th>
                  <th className="pb-2.5 font-medium">自定义选择器</th>
                  <th className="pb-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-zinc-800/80">
                {settings.siteRules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="py-3 pr-3">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) =>
                          patchSettings((prev) => ({
                            ...prev,
                            siteRules: prev.siteRules.map((r) =>
                              r.id === rule.id
                                ? { ...r, enabled: e.target.checked }
                                : r,
                            ),
                          }))
                        }
                        className="h-4 w-4 rounded accent-blue-600"
                      />
                    </td>
                    <td className="py-3 pr-4 font-mono font-semibold">
                      {rule.pattern}
                    </td>
                    <td className="py-3 pr-4">
                      <select
                        value={rule.action}
                        onChange={(e) =>
                          patchSettings((prev) => ({
                            ...prev,
                            siteRules: prev.siteRules.map((r) =>
                              r.id === rule.id
                                ? {
                                    ...r,
                                    action: e.target.value as SiteRuleAction,
                                  }
                                : r,
                            ),
                          }))
                        }
                        className="h-8 rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs dark:border-zinc-700 dark:bg-zinc-800"
                      >
                        <option value="always-bilingual">总是自动双语对照</option>
                        <option value="always-translated-only">
                          总是自动仅看译文
                        </option>
                        <option value="never-translate">不自动翻译</option>
                        <option value="none">手动触发</option>
                      </select>
                    </td>
                    <td className="py-3 pr-4">
                      <label className="inline-flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={rule.hideFloatingTab}
                          onChange={(e) =>
                            patchSettings((prev) => ({
                              ...prev,
                              siteRules: prev.siteRules.map((r) =>
                                r.id === rule.id
                                  ? { ...r, hideFloatingTab: e.target.checked }
                                  : r,
                              ),
                            }))
                          }
                          className="h-4 w-4 rounded accent-blue-600"
                        />
                        <span>隐藏悬浮签</span>
                      </label>
                    </td>
                    <td className="py-3 pr-4 font-mono text-slate-500">
                      {rule.customSelectors || '自动识别'}
                    </td>
                    <td className="py-3 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          patchSettings((prev) => ({
                            ...prev,
                            siteRules: prev.siteRules.filter(
                              (r) => r.id !== rule.id,
                            ),
                          }))
                        }
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
