import React, { useEffect, useRef, useState } from 'react';
import { Ban, Code2, EyeOff, Settings, Sparkles } from 'lucide-react';
import {
  matchSiteRule,
  resolvePrimaryService,
  STYLE_PRESET_OPTIONS,
  updateSettings,
} from '../../../src/storage';
import { formatShortcutLabel } from '../../../src/shortcuts';
import type {
  ExtensionSettings,
  PageTabState,
  PageViewMode,
  TranslationStylePreset,
} from '../../../src/types';
import type { PageTranslationController } from '../dom/controller';
import { isGitHubCodeHost } from '../dom/github-comments';

interface FloatingTabProps {
  controller: PageTranslationController;
  settings: ExtensionSettings;
  tabState: PageTabState;
}

const SHORT_STYLE_LABELS: Record<TranslationStylePreset, string> = {
  blockquote: '引线风',
  default: '默认',
  muted: '弱化',
  dashed: '虚线',
  marker: '马克笔',
  mask: '遮罩',
};

export const FloatingTab: React.FC<FloatingTabProps> = ({
  controller,
  settings,
  tabState,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [localTopRatio, setLocalTopRatio] = useState(
    settings.floatingTab.topRatio,
  );
  const [localSide, setLocalSide] = useState(settings.floatingTab.side);

  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStateRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
  }>({ active: false, moved: false, startX: 0, startY: 0 });

  useEffect(() => {
    setLocalTopRatio(settings.floatingTab.topRatio);
    setLocalSide(settings.floatingTab.side);
  }, [settings.floatingTab.topRatio, settings.floatingTab.side]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const hostname = window.location.hostname;
  const currentRule = matchSiteRule(hostname, settings.siteRules);

  if (
    !settings.floatingTab.enabled ||
    currentRule?.hideFloatingTab ||
    isFullscreen
  ) {
    return null;
  }

  const enabledServices = settings.services.filter((s) => s.enabled);
  const activeService = resolvePrimaryService(settings);
  const isActive = tabState.mode !== 'original';
  const isGitHub = isGitHubCodeHost(hostname);

  const handleMouseEnter = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (!dragStateRef.current.active) {
      setExpanded(true);
    }
  };

  const handleMouseLeave = () => {
    closeTimerRef.current = setTimeout(() => {
      setExpanded(false);
    }, 180);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragStateRef.current.active) return;
    const dist = Math.hypot(
      e.clientX - dragStateRef.current.startX,
      e.clientY - dragStateRef.current.startY,
    );
    if (dist > 5) {
      dragStateRef.current.moved = true;
      setDragging(true);
      setExpanded(false);
      const ratio = Math.min(
        0.92,
        Math.max(0.08, e.clientY / Math.max(1, window.innerHeight)),
      );
      const nextSide = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
      setLocalTopRatio(ratio);
      setLocalSide(nextSide);
    }
  };

  const handlePointerUp = async (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragStateRef.current.active) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const wasMoved = dragStateRef.current.moved;
    dragStateRef.current.active = false;
    setDragging(false);

    if (wasMoved) {
      await updateSettings((prev) => ({
        ...prev,
        floatingTab: {
          ...prev.floatingTab,
          side: localSide,
          topRatio: localTopRatio,
        },
      }));
    } else {
      controller.toggleBilingual();
    }
  };

  const handleSetMode = (mode: PageViewMode) => {
    controller.setMode(mode);
  };

  const handleToggleAlwaysDomain = async () => {
    if (!hostname) return;
    await updateSettings((prev) => {
      const idx = prev.siteRules.findIndex((r) => r.pattern === hostname);
      const nextAction =
        currentRule?.action === 'always-bilingual' ? 'none' : 'always-bilingual';

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

  const handleToggleNeverDomain = async () => {
    if (!hostname) return;
    await updateSettings((prev) => {
      const idx = prev.siteRules.findIndex((r) => r.pattern === hostname);
      const nextAction =
        currentRule?.action === 'never-translate' ? 'none' : 'never-translate';

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

  const handleHideOnDomain = async () => {
    if (!hostname) return;
    setExpanded(false);
    await updateSettings((prev) => {
      const idx = prev.siteRules.findIndex((r) => r.pattern === hostname);
      if (idx >= 0) {
        return {
          ...prev,
          siteRules: prev.siteRules.map((r, i) =>
            i === idx ? { ...r, hideFloatingTab: true, enabled: true } : r,
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
            hideFloatingTab: true,
            enabled: true,
          },
          ...prev.siteRules,
        ],
      };
    });
  };

  return (
    <div
      className="bo-fab-wrap"
      data-side={localSide}
      data-expanded={expanded ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : 'false'}
      style={{ top: `${ (localTopRatio * 100).toFixed(1) }%`, transform: 'translateY(-50%)' }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className="bo-fab-btn"
        data-active={isActive ? 'true' : 'false'}
        title={`单击切换双语对照 (${ formatShortcutLabel(settings.shortcuts.toggleBilingual) }) · 上下拖拽可移动`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {tabState.inFlightCount > 0 && <span className="bo-fab-spinner" />}
        <span className="bo-fab-glyph">
          {tabState.mode === 'translated-only' ? '译' : isActive ? '双' : '译'}
        </span>
      </button>

      {expanded && !dragging && (
        <div className="bo-fab-panel">
          <div className="bo-segmented">
            <button
              type="button"
              className="bo-seg-btn"
              data-active={tabState.mode === 'original' ? 'true' : 'false'}
              onClick={() => handleSetMode('original')}
            >
              原文
            </button>
            <button
              type="button"
              className="bo-seg-btn"
              data-active={tabState.mode === 'bilingual' ? 'true' : 'false'}
              onClick={() => handleSetMode('bilingual')}
            >
              双语对照
            </button>
            <button
              type="button"
              className="bo-seg-btn"
              data-active={tabState.mode === 'translated-only' ? 'true' : 'false'}
              onClick={() => handleSetMode('translated-only')}
            >
              仅看译文
            </button>
          </div>

          <div className="bo-field-row">
            <div className="bo-field-label">
              <span>主翻译服务</span>
              <span style={{ opacity: 0.75 }}>{activeService.model}</span>
            </div>
            <select
              className="bo-select"
              value={activeService.id}
              onChange={(e) =>
                updateSettings({ primaryServiceId: e.target.value })
              }
            >
              {enabledServices.map((svc) => (
                <option key={svc.id} value={svc.id}>
                  {svc.name} ({svc.model})
                </option>
              ))}
            </select>
          </div>

          <div className="bo-field-row">
            <div className="bo-field-label">
              <span>译文呈现样式</span>
              <button
                type="button"
                className="bo-ghost-btn"
                style={{ fontSize: '11px', padding: '1px 5px' }}
                title="切换智能对比度配色与原色对照"
                onClick={() =>
                  updateSettings({
                    colorMode:
                      settings.colorMode === 'adaptive' ? 'inherit' : 'adaptive',
                  })
                }
              >
                {settings.colorMode === 'adaptive' ? '🎨 智能双色' : '◐ 原色对照'}
              </button>
            </div>
            <div className="bo-style-grid">
              {STYLE_PRESET_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="bo-chip-btn"
                  data-active={
                    settings.stylePreset === opt.value ? 'true' : 'false'
                  }
                  title={opt.description}
                  onClick={() => updateSettings({ stylePreset: opt.value })}
                >
                  {SHORT_STYLE_LABELS[opt.value]}
                </button>
              ))}
            </div>
          </div>

          {isGitHub && (
            <div className="bo-field-row">
              <button
                type="button"
                className="bo-chip-btn"
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '5px',
                }}
                data-active={
                  settings.enableGithubCommentTranslation ? 'true' : 'false'
                }
                onClick={() =>
                  updateSettings({
                    enableGithubCommentTranslation:
                      !settings.enableGithubCommentTranslation,
                  })
                }
              >
                <Code2 size={12} />
                <span>
                  {settings.enableGithubCommentTranslation
                    ? '已开启代码行内注释翻译'
                    : '开启代码行内注释翻译'}
                </span>
              </button>
            </div>
          )}

          <div className="bo-panel-footer">
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button
                type="button"
                className="bo-ghost-btn"
                style={{
                  color:
                    currentRule?.action === 'always-bilingual'
                      ? 'var(--bo-accent)'
                      : undefined,
                }}
                onClick={handleToggleAlwaysDomain}
                title="下次打开该域名时自动开启双语对照"
              >
                <Sparkles size={12} />
                <span>
                  {currentRule?.action === 'always-bilingual'
                    ? '已自动'
                    : '自动双语'}
                </span>
              </button>

              <button
                type="button"
                className="bo-ghost-btn"
                style={{
                  color:
                    currentRule?.action === 'never-translate'
                      ? '#f59e0b'
                      : undefined,
                }}
                onClick={handleToggleNeverDomain}
                title="一键将此域名加入免译名单"
              >
                <Ban size={12} />
                <span>
                  {currentRule?.action === 'never-translate'
                    ? '已免译'
                    : '此站免译'}
                </span>
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
              <button
                type="button"
                className="bo-ghost-btn"
                title="在此网站隐藏悬浮快捷签"
                onClick={handleHideOnDomain}
              >
                <EyeOff size={13} />
              </button>
              <button
                type="button"
                className="bo-ghost-btn"
                title="打开翻译与术语设置中心"
                onClick={() => {
                  chrome.runtime
                    .sendMessage({ type: 'OPEN_OPTIONS_PAGE' })
                    .catch(() => {});
                }}
              >
                <Settings size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
