import React, { useEffect, useState } from 'react';
import { BookOpen, Globe, Keyboard, Server } from 'lucide-react';
import { useSettings } from '../../src/storage/useSettings';
import { GlossaryTab } from './tabs/GlossaryTab';
import { ServicesTab } from './tabs/ServicesTab';
import { ShortcutsAndStyleTab } from './tabs/ShortcutsAndStyleTab';
import { SiteRulesTab } from './tabs/SiteRulesTab';

type TabKey = 'services' | 'glossary' | 'shortcuts' | 'sites';

const NAV_TABS: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
  { key: 'services', label: '模型与服务配置', icon: <Server size={16} /> },
  { key: 'glossary', label: '全局术语库', icon: <BookOpen size={16} /> },
  {
    key: 'shortcuts',
    label: '快捷键与译文外观',
    icon: <Keyboard size={16} />,
  },
  { key: 'sites', label: '站点规则', icon: <Globe size={16} /> },
];

function parseHashTab(): TabKey {
  const raw = window.location.hash.replace('#', '').trim();
  if (
    raw === 'services' ||
    raw === 'glossary' ||
    raw === 'shortcuts' ||
    raw === 'sites'
  ) {
    return raw;
  }
  return 'services';
}

export const App: React.FC = () => {
  const { settings, loading, patchSettings } = useSettings();
  const [activeTab, setActiveTab] = useState<TabKey>(parseHashTab);

  useEffect(() => {
    const onHashChange = () => setActiveTab(parseHashTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (key: TabKey) => {
    window.location.hash = key;
    setActiveTab(key);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">
        正在加载配置…
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 md:flex-row md:px-8">
      {/* Sidebar */}
      <aside className="w-full shrink-0 md:w-56">
        <div className="mb-6 flex items-center gap-3 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-base font-bold text-white shadow-sm">
            译
          </div>
          <div>
            <div className="text-base font-bold tracking-tight">
              Bo Translation
            </div>
            <div className="text-xs text-slate-500 dark:text-zinc-400">
              沉浸式网页双语对照
            </div>
          </div>
        </div>

        <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col">
          {NAV_TABS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => switchTab(tab.key)}
                className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-xs font-medium whitespace-nowrap transition ${
                  active
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-200/60 dark:text-zinc-400 dark:hover:bg-zinc-800/70'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="min-w-0 flex-1">
        {activeTab === 'services' && (
          <ServicesTab settings={settings} patchSettings={patchSettings} />
        )}
        {activeTab === 'glossary' && (
          <GlossaryTab settings={settings} patchSettings={patchSettings} />
        )}
        {activeTab === 'shortcuts' && (
          <ShortcutsAndStyleTab
            settings={settings}
            patchSettings={patchSettings}
          />
        )}
        {activeTab === 'sites' && (
          <SiteRulesTab settings={settings} patchSettings={patchSettings} />
        )}
      </main>
    </div>
  );
};
