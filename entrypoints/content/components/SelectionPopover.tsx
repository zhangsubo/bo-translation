import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookPlus, Check, Copy, RefreshCw, X } from 'lucide-react';
import {
  resolveSelectionService,
  updateSettings,
  upsertGlossaryEntry,
} from '../../../src/storage';
import { isEditableTarget } from '../../../src/shortcuts';
import {
  STREAM_PORT_NAME,
  type ExtensionSettings,
  type GlossaryStrategy,
  type StreamPortClientMessage,
  type StreamPortServerMessage,
} from '../../../src/types';
import { consumeRuntimeLastError } from '../../../src/utils/runtime';
import { BO_TRANS_TAG, BO_UI_HOST_TAG } from '../dom/rules';

interface SelectionPopoverProps {
  settings: ExtensionSettings;
  shortcutSignal: number;
}

interface LookupResultState {
  serviceId: string;
  serviceName: string;
  status: 'loading' | 'streaming' | 'done' | 'error';
  text: string;
  error?: string;
}

function getCleanParagraphContext(range: Range): string {
  let node: Node | null = range.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }

  if (node instanceof Element) {
    const subCueEl = node.closest('[data-bo-subtitle-cue]');
    if (subCueEl) {
      const origLine = subCueEl.querySelector('[data-bo-subtitle-orig]');
      const subText = (origLine?.textContent ?? subCueEl.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      return subText.slice(0, 720);
    }
  }

  const el =
    node instanceof Element
      ? node.closest('p, li, td, th, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, article, div')
      : null;

  if (!el) return '';

  // Clone and remove any injected `<bo-trans>` elements so context stays pure original text
  const clone = el.cloneNode(true) as Element;
  for (const injected of Array.from(clone.querySelectorAll(BO_TRANS_TAG))) {
    injected.remove();
  }
  const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 720);
}

function checkIsWordOrPhrase(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 44 || /\n/.test(trimmed)) return false;
  if (/[.?!;。？！；]$/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  return words.length <= 4;
}

function clampPosition(x: number, y: number, width: number, height: number) {
  const vw = window.visualViewport?.width ?? window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  return {
    left: Math.max(12, Math.min(x, vw - width - 12)),
    top: Math.max(12, Math.min(y, vh - height - 12)),
  };
}

export const SelectionPopover: React.FC<SelectionPopoverProps> = ({
  settings,
  shortcutSignal,
}) => {
  const [triggerPos, setTriggerPos] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number }>({
    left: 120,
    top: 120,
  });

  const [selectedText, setSelectedText] = useState('');
  const [contextText, setContextText] = useState('');
  const [isWordMode, setIsWordMode] = useState(false);

  const [activeServiceIds, setActiveServiceIds] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, LookupResultState>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Glossary quick-save drawer state
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [glossaryTarget, setGlossaryTarget] = useState('');
  const [glossaryStrategy, setGlossaryStrategy] =
    useState<GlossaryStrategy>('translate');
  const [glossarySaved, setGlossarySaved] = useState(false);

  const dismissedTextRef = useRef<string>('');
  const pendingSelectionRef = useRef<{
    text: string;
    context: string;
    rect: DOMRect;
  } | null>(null);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const requestMapRef = useRef<Map<string, string>>(new Map()); // requestId -> serviceId

  const closeAll = useCallback((rememberDismissed = true) => {
    if (rememberDismissed && pendingSelectionRef.current?.text) {
      dismissedTextRef.current = pendingSelectionRef.current.text;
    }
    setTriggerPos(null);
    setPopoverOpen(false);
    setGlossaryOpen(false);
    setGlossarySaved(false);

    if (portRef.current) {
      for (const reqId of requestMapRef.current.keys()) {
        try {
          portRef.current.postMessage({
            type: 'CANCEL_REQUEST',
            requestId: reqId,
          } satisfies StreamPortClientMessage);
        } catch {
          // ignore
        }
      }
      requestMapRef.current.clear();
    }
  }, []);

  const ensurePort = useCallback(() => {
    if (portRef.current) return portRef.current;
    const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    portRef.current = port;

    port.onMessage.addListener((msg: StreamPortServerMessage) => {
      if (
        msg.type !== 'LOOKUP_DELTA' &&
        msg.type !== 'LOOKUP_DONE' &&
        msg.type !== 'LOOKUP_ERROR'
      ) {
        return;
      }
      if (!requestMapRef.current.has(msg.requestId)) return;

      if (msg.type === 'LOOKUP_DELTA') {
        setResults((prev) => ({
          ...prev,
          [msg.serviceId]: {
            serviceId: msg.serviceId,
            serviceName: msg.serviceName,
            status: 'streaming',
            text: msg.fullText,
          },
        }));
      } else if (msg.type === 'LOOKUP_DONE') {
        requestMapRef.current.delete(msg.requestId);
        setResults((prev) => ({
          ...prev,
          [msg.serviceId]: {
            serviceId: msg.serviceId,
            serviceName: msg.serviceName,
            status: 'done',
            text: msg.fullText,
          },
        }));
      } else if (msg.type === 'LOOKUP_ERROR') {
        requestMapRef.current.delete(msg.requestId);
        setResults((prev) => ({
          ...prev,
          [msg.serviceId]: {
            serviceId: msg.serviceId,
            serviceName: msg.serviceName,
            status: 'error',
            text: '',
            error: msg.error,
          },
        }));
      }
    });

    port.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      portRef.current = null;
      requestMapRef.current.clear();
    });

    return port;
  }, []);

  useEffect(() => {
    const closePort = () => {
      if (portRef.current) {
        const activePort = portRef.current;
        portRef.current = null;
        requestMapRef.current.clear();
        try {
          activePort.disconnect();
        } catch {
          // ignore already closed port
        }
      }
    };
    window.addEventListener('pagehide', closePort);
    return () => {
      window.removeEventListener('pagehide', closePort);
      closePort();
    };
  }, []);

  const fireLookupForServices = useCallback(
    (
      svcIds: string[],
      text: string,
      ctx: string,
      wordMode: boolean,
    ) => {
      const port = ensurePort();
      const enabledMap = new Map(
        settings.services.filter((s) => s.enabled).map((s) => [s.id, s]),
      );

      for (const svcId of svcIds) {
        const svc = enabledMap.get(svcId);
        if (!svc) continue;

        const reqId = `lookup_${ Date.now() }_${ svcId }_${ Math.random().toString(36).slice(2, 6) }`;
        requestMapRef.current.set(reqId, svcId);

        setResults((prev) => ({
          ...prev,
          [svcId]: {
            serviceId: svcId,
            serviceName: svc.name,
            status: 'loading',
            text: '',
          },
        }));

        port.postMessage({
          type: 'SELECTION_LOOKUP',
          requestId: reqId,
          serviceId: svcId,
          selectedText: text,
          contextText: ctx,
          docTitle: document.title,
          isWordOrPhrase: wordMode,
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang,
        } satisfies StreamPortClientMessage);
      }
    },
    [ensurePort, settings],
  );

  const openPopoverWithSelection = useCallback(
    (text: string, ctx: string, anchorRect: DOMRect) => {
      const wordMode = checkIsWordOrPhrase(text);
      setSelectedText(text);
      setContextText(ctx);
      setIsWordMode(wordMode);
      setTriggerPos(null);
      setPopoverOpen(true);
      setGlossaryOpen(false);
      setGlossarySaved(false);
      setGlossaryTarget('');

      const clamped = clampPosition(
        anchorRect.left,
        anchorRect.bottom + 8,
        380,
        290,
      );
      setPopoverPos(clamped);

      const defaultSvc = resolveSelectionService(settings);
      const validCompare = settings.comparisonServiceIds.filter((id) =>
        settings.services.some((s) => s.id === id && s.enabled),
      );
      const initialIds =
        validCompare.length > 0
          ? Array.from(new Set([defaultSvc.id, ...validCompare])).slice(0, 3)
          : [defaultSvc.id];

      setActiveServiceIds(initialIds);
      setResults({});
      fireLookupForServices(initialIds, text, ctx, wordMode);
    },
    [fireLookupForServices, settings],
  );

  // Trigger via custom keyboard shortcut (e.g. Alt+D)
  useEffect(() => {
    if (shortcutSignal === 0) return;
    const sel = window.getSelection();
    const text = (sel?.toString() ?? '').trim();
    if (!text || !sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const ctx = getCleanParagraphContext(range);
    pendingSelectionRef.current = { text, context: ctx, rect };
    openPopoverWithSelection(text, ctx, rect);
  }, [shortcutSignal, openPopoverWithSelection]);

  // Watch mouseup text selections
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target instanceof Element && target.closest(BO_UI_HOST_TAG)) {
        return;
      }
      if (isEditableTarget(e.target)) {
        return;
      }

      setTimeout(() => {
        const sel = window.getSelection();
        const text = (sel?.toString() ?? '').trim();

        if (!text || text.length < 2 || text.length > 2400 || !sel || sel.rangeCount === 0) {
          dismissedTextRef.current = '';
          if (!popoverOpen) {
            setTriggerPos(null);
          }
          return;
        }

        if (text === dismissedTextRef.current) {
          return;
        }

        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const ctx = getCleanParagraphContext(range);
        pendingSelectionRef.current = { text, context: ctx, rect };

        if (settings.showSelectionTriggerIcon && !popoverOpen) {
          setTriggerPos(
            clampPosition(e.clientX + 8, e.clientY + 10, 34, 34),
          );
        }
      }, 15);
    };

    const onMouseDown = (e: MouseEvent) => {
      const path = e.composedPath();
      const insideUi = path.some(
        (node) =>
          node instanceof Element &&
          node.tagName === BO_UI_HOST_TAG.toUpperCase(),
      );
      if (!insideUi) {
        if (popoverOpen || triggerPos) {
          closeAll(true);
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (popoverOpen || triggerPos)) {
        closeAll(true);
      }
    };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeAll, popoverOpen, settings.showSelectionTriggerIcon, triggerPos]);

  const handleToggleCompareService = async (svcId: string) => {
    const exists = activeServiceIds.includes(svcId);
    let nextIds: string[];
    if (exists) {
      if (activeServiceIds.length <= 1) return; // keep at least 1
      nextIds = activeServiceIds.filter((id) => id !== svcId);
    } else {
      nextIds = [...activeServiceIds, svcId].slice(-3);
      if (!results[svcId]) {
        fireLookupForServices([svcId], selectedText, contextText, isWordMode);
      }
    }
    setActiveServiceIds(nextIds);
    const defaultSvcId = resolveSelectionService(settings).id;
    await updateSettings({
      comparisonServiceIds: nextIds.filter((id) => id !== defaultSvcId),
    });
  };

  const handleDragHeaderDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = popoverPos.left;
    const origTop = popoverPos.top;

    const onMove = (ev: PointerEvent) => {
      setPopoverPos(
        clampPosition(
          origLeft + (ev.clientX - startX),
          origTop + (ev.clientY - startY),
          380,
          200,
        ),
      );
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleCopy = async (svcId: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(svcId);
    setTimeout(() => setCopiedId(null), 1400);
  };

  const handleSaveGlossary = async () => {
    if (!selectedText.trim()) return;
    if (glossaryStrategy === 'translate' && !glossaryTarget.trim()) return;

    await upsertGlossaryEntry({
      source: selectedText.trim(),
      target: glossaryTarget.trim(),
      strategy: glossaryStrategy,
      caseSensitive: /^[A-Z]/.test(selectedText.trim()),
      note: document.title ? `来自: ${ document.title.slice(0, 40) }` : '',
      enabled: true,
    });
    setGlossarySaved(true);
    setTimeout(() => {
      setGlossaryOpen(false);
    }, 900);
  };

  if (triggerPos && !popoverOpen) {
    return (
      <button
        type="button"
        className="bo-sel-trigger"
        style={{ left: `${ triggerPos.left }px`, top: `${ triggerPos.top }px` }}
        title="查看上下文释义 / 翻译"
        onClick={(e) => {
          e.stopPropagation();
          if (pendingSelectionRef.current) {
            openPopoverWithSelection(
              pendingSelectionRef.current.text,
              pendingSelectionRef.current.context,
              pendingSelectionRef.current.rect,
            );
          }
        }}
      >
        译
      </button>
    );
  }

  if (!popoverOpen) return null;

  const enabledServices = settings.services.filter((s) => s.enabled);

  return (
    <div
      className="bo-popover"
      style={{ left: `${ popoverPos.left }px`, top: `${ popoverPos.top }px` }}
    >
      <div className="bo-popover-header" onPointerDown={handleDragHeaderDown}>
        <div className="bo-popover-title">
          <span className="bo-badge">
            {isWordMode ? '语境释义' : '选段翻译'}
          </span>
          <span className="bo-sel-preview" title={selectedText}>
            {selectedText}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {selectedText.length <= 48 && (
            <button
              type="button"
              className="bo-ghost-btn"
              style={{
                color: glossarySaved ? '#16a34a' : 'var(--bo-accent)',
                fontWeight: 600,
              }}
              onClick={() => setGlossaryOpen((v) => !v)}
              title="将该词加入全局术语表，统一后续阅读译法"
            >
              <BookPlus size={13} />
              <span>{glossarySaved ? '已存术语' : '+ 术语'}</span>
            </button>
          )}
          <button
            type="button"
            className="bo-ghost-btn"
            onClick={() => closeAll(true)}
            title="关闭 (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {enabledServices.length > 1 && (
        <div className="bo-popover-toolbar">
          <div className="bo-svc-pills">
            {enabledServices.map((svc) => (
              <button
                key={svc.id}
                type="button"
                className="bo-chip-btn"
                data-active={
                  activeServiceIds.includes(svc.id) ? 'true' : 'false'
                }
                onClick={() => handleToggleCompareService(svc.id)}
                title="点击可并排开启/关闭多模型对比（最多 3 个）"
              >
                {svc.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="bo-popover-body">
        {activeServiceIds.map((svcId) => {
          const item = results[svcId];
          const svcName =
            item?.serviceName ??
            enabledServices.find((s) => s.id === svcId)?.name ??
            '模型';

          return (
            <div key={svcId} className="bo-result-card">
              <div className="bo-result-head">
                <span>{svcName}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {item?.text && (
                    <button
                      type="button"
                      className="bo-ghost-btn"
                      onClick={() => handleCopy(svcId, item.text)}
                      title="复制内容"
                    >
                      {copiedId === svcId ? (
                        <Check size={12} color="#16a34a" />
                      ) : (
                        <Copy size={12} />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="bo-ghost-btn"
                    onClick={() =>
                      fireLookupForServices(
                        [svcId],
                        selectedText,
                        contextText,
                        isWordMode,
                      )
                    }
                    title="重新生成"
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
              </div>

              {item?.status === 'loading' && (
                <div
                  style={{
                    fontSize: '12px',
                    color: 'var(--bo-text-muted)',
                  }}
                >
                  正在结合上下文解析…
                </div>
              )}

              {item?.status === 'error' && (
                <div style={{ fontSize: '12px', color: '#dc2626' }}>
                  {item.error || '查询失败'}
                </div>
              )}

              {item?.text && <div className="bo-result-text">{item.text}</div>}
            </div>
          );
        })}
      </div>

      {glossaryOpen && (
        <div className="bo-glossary-drawer">
          <div className="bo-field-label">
            <span>加入全局术语表：「{selectedText.slice(0, 28)}」</span>
          </div>
          <div className="bo-glossary-row">
            <select
              className="bo-select"
              style={{ width: '112px', flexShrink: 0 }}
              value={glossaryStrategy}
              onChange={(e) =>
                setGlossaryStrategy(e.target.value as GlossaryStrategy)
              }
            >
              <option value="translate">指定译文</option>
              <option value="keep">保留不译</option>
            </select>

            {glossaryStrategy === 'translate' && (
              <input
                type="text"
                className="bo-input"
                placeholder="输入固定译法，如：水合"
                value={glossaryTarget}
                onChange={(e) => setGlossaryTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveGlossary();
                }}
              />
            )}

            <button
              type="button"
              className="bo-primary-btn"
              onClick={handleSaveGlossary}
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
