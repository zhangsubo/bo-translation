import React, { useRef, useState } from 'react';
import { Download, Plus, Search, Trash2, Upload } from 'lucide-react';
import {
  exportGlossaryCsv,
  exportGlossaryJson,
  parseGlossaryImport,
} from '../../../src/glossary';
import type {
  ExtensionSettings,
  GlossaryEntry,
  GlossaryStrategy,
} from '../../../src/types';

interface GlossaryTabProps {
  settings: ExtensionSettings;
  patchSettings: (
    updater:
      | Partial<ExtensionSettings>
      | ((prev: ExtensionSettings) => ExtensionSettings),
  ) => Promise<ExtensionSettings>;
}

export const GlossaryTab: React.FC<GlossaryTabProps> = ({
  settings,
  patchSettings,
}) => {
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [strategy, setStrategy] = useState<GlossaryStrategy>('translate');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!source.trim()) return;
    if (strategy === 'translate' && !target.trim()) return;

    const newItem: GlossaryEntry = {
      id: `gls_${ Date.now() }_${ Math.random().toString(36).slice(2, 6) }`,
      source: source.trim(),
      target: strategy === 'keep' ? '' : target.trim(),
      strategy,
      caseSensitive,
      note: note.trim(),
      enabled: true,
      createdAt: Date.now(),
    };

    await patchSettings((prev) => ({
      ...prev,
      glossary: [
        newItem,
        ...prev.glossary.filter(
          (g) => g.source.toLowerCase() !== newItem.source.toLowerCase(),
        ),
      ],
    }));

    setSource('');
    setTarget('');
    setNote('');
  };

  const triggerDownload = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = parseGlossaryImport(text);
      if (imported.length === 0) {
        setFeedback('未在文件中解析到有效术语条目');
        return;
      }

      await patchSettings((prev) => {
        const merged = [...prev.glossary];
        for (const entry of imported) {
          const idx = merged.findIndex(
            (m) => m.source.toLowerCase() === entry.source.toLowerCase(),
          );
          const existing = idx >= 0 ? merged[idx] : undefined;
          if (existing) {
            merged[idx] = { ...existing, ...entry, id: existing.id };
          } else {
            merged.unshift(entry);
          }
        }
        return { ...prev, glossary: merged };
      });

      setFeedback(`已成功导入/更新 ${ imported.length } 条术语规则`);
      setTimeout(() => setFeedback(''), 3000);
    } catch {
      setFeedback('导入失败：请确认 JSON 或 CSV 格式正确');
    } finally {
      e.target.value = '';
    }
  };

  const filtered = settings.glossary.filter((item) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      item.source.toLowerCase().includes(q) ||
      item.target.toLowerCase().includes(q) ||
      (item.note ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex flex-col gap-6">
      {/* Add Form */}
      <form
        onSubmit={handleAdd}
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">全局术语库</h2>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.csv,.txt"
              onChange={handleImportFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <Upload size={13} /> 导入 CSV/JSON
            </button>
            <button
              type="button"
              onClick={() =>
                triggerDownload(
                  exportGlossaryCsv(settings.glossary),
                  'bo-glossary.csv',
                  'text/csv;charset=utf-8',
                )
              }
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <Download size={13} /> 导出 CSV
            </button>
            <button
              type="button"
              onClick={() =>
                triggerDownload(
                  exportGlossaryJson(settings.glossary),
                  'bo-glossary.json',
                  'application/json',
                )
              }
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              <Download size={13} /> 导出 JSON
            </button>
          </div>
        </div>
        <p className="mb-4 text-xs text-slate-500 dark:text-zinc-400">
          仅在服务勾选「挂载全局术语表」且当前翻译段落实际命中词汇时按需生效。「保留原文」走占位硬锁，绝不误译。
        </p>

        {feedback && (
          <div className="mb-4 rounded-xl bg-blue-50 px-3.5 py-2 text-xs text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
            {feedback}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-12">
          <input
            type="text"
            placeholder="原文术语（如 hydration）"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 sm:col-span-3 dark:border-zinc-700 dark:bg-zinc-800"
          />

          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as GlossaryStrategy)}
            className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs outline-none focus:border-blue-500 sm:col-span-2 dark:border-zinc-700 dark:bg-zinc-800"
          >
            <option value="translate">指定固定译法</option>
            <option value="keep">强制保留原文</option>
          </select>

          <input
            type="text"
            disabled={strategy === 'keep'}
            placeholder={
              strategy === 'keep' ? '保留原文不翻译' : '指定译文（如 水合）'
            }
            value={strategy === 'keep' ? '' : target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 disabled:opacity-50 sm:col-span-3 dark:border-zinc-700 dark:bg-zinc-800"
          />

          <input
            type="text"
            placeholder="备注（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-9 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs outline-none focus:border-blue-500 sm:col-span-2 dark:border-zinc-700 dark:bg-zinc-800"
          />

          <div className="flex items-center justify-between gap-2 sm:col-span-2">
            <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-slate-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
                className="h-3.5 w-3.5 rounded accent-blue-600"
              />
              区分大小写
            </label>
            <button
              type="submit"
              className="inline-flex h-9 items-center gap-1 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700"
            >
              <Plus size={14} /> 添加
            </button>
          </div>
        </div>
      </form>

      {/* Glossary Table */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="relative w-72">
            <Search
              size={14}
              className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
            />
            <input
              type="text"
              placeholder="搜索术语或备注…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-8 text-xs outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
            />
          </div>
          <span className="text-xs text-slate-500 dark:text-zinc-400">
            共 {filtered.length} 条术语
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-400">
            暂无匹配的术语规则，可在上方添加，或在阅读网页划词时点击「+ 术语」快速收录。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="pb-2.5 font-medium">启用</th>
                  <th className="pb-2.5 font-medium">原文术语</th>
                  <th className="pb-2.5 font-medium">策略与目标译文</th>
                  <th className="pb-2.5 font-medium">大小写</th>
                  <th className="pb-2.5 font-medium">备注</th>
                  <th className="pb-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-zinc-800/80">
                {filtered.map((entry) => (
                  <tr key={entry.id} className="group">
                    <td className="py-3 pr-3">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(e) =>
                          patchSettings((prev) => ({
                            ...prev,
                            glossary: prev.glossary.map((g) =>
                              g.id === entry.id
                                ? { ...g, enabled: e.target.checked }
                                : g,
                            ),
                          }))
                        }
                        className="h-4 w-4 rounded accent-blue-600"
                      />
                    </td>
                    <td className="py-3 pr-4 font-mono font-semibold">
                      {entry.source}
                    </td>
                    <td className="py-3 pr-4">
                      {entry.strategy === 'keep' ? (
                        <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                          强制保留原文
                        </span>
                      ) : (
                        <span className="font-medium text-blue-600 dark:text-blue-400">
                          → {entry.target}
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-slate-500">
                      {entry.caseSensitive ? '严格匹配' : '忽略大小写'}
                    </td>
                    <td className="py-3 pr-4 text-slate-500 dark:text-zinc-400">
                      {entry.note || '—'}
                    </td>
                    <td className="py-3 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          patchSettings((prev) => ({
                            ...prev,
                            glossary: prev.glossary.filter(
                              (g) => g.id !== entry.id,
                            ),
                          }))
                        }
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                        title="删除"
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
