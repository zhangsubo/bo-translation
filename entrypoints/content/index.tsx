import contentUiCss from './style.css?inline';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { isBrowserPdfDocument } from '../../src/pdf/layout';
import { getSettings, subscribeSettings } from '../../src/storage';
import { isEditableTarget, matchesShortcut } from '../../src/shortcuts';
import type {
  ExtensionSettings,
  PageTabState,
  RuntimeRequestMessage,
} from '../../src/types';
import { FloatingTab } from './components/FloatingTab';
import { ParagraphToolbar } from './components/ParagraphToolbar';
import { SelectionPopover } from './components/SelectionPopover';
import { PageTranslationController } from './dom/controller';
import { BO_UI_HOST_TAG } from './dom/rules';
import { SubtitleController } from './subtitle/SubtitleController';

interface ContentAppProps {
  controller: PageTranslationController;
  subtitleController: SubtitleController;
  initialSettings: ExtensionSettings;
}

const ContentApp: React.FC<ContentAppProps> = ({
  controller,
  subtitleController,
  initialSettings,
}) => {
  const [settings, setSettings] = useState<ExtensionSettings>(initialSettings);
  const [tabState, setTabState] = useState<PageTabState>(() =>
    controller.getState(),
  );
  const [lookupSignal, setLookupSignal] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(() =>
    Boolean(document.fullscreenElement),
  );

  useEffect(() => {
    const unsubSettings = subscribeSettings((next) => {
      controller.updateSettings(next);
      subtitleController.updateSettings(next);
      setSettings(next);
    });
    const unsubState = controller.subscribeState((nextState) => {
      setTabState(nextState);
    });
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      unsubSettings();
      unsubState();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [controller, subtitleController]);

  // Global custom keyboard shortcut listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || isEditableTarget(e.target)) return;

      const { shortcuts } = settings;
      if (matchesShortcut(e, shortcuts.toggleBilingual)) {
        e.preventDefault();
        controller.toggleBilingual();
        return;
      }
      if (matchesShortcut(e, shortcuts.toggleTranslatedOnly)) {
        e.preventDefault();
        controller.toggleTranslatedOnly();
        return;
      }
      if (matchesShortcut(e, shortcuts.selectionLookup)) {
        const selText = (window.getSelection()?.toString() ?? '').trim();
        if (selText) {
          e.preventDefault();
          setLookupSignal((n) => n + 1);
        }
        return;
      }
      if (matchesShortcut(e, shortcuts.retranslateParagraph)) {
        if (controller.retranslateHoveredSegment()) {
          e.preventDefault();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [controller, settings]);

  return (
    <div className="bo-ui-root">
      {!isFullscreen && (
        <FloatingTab
          controller={controller}
          settings={settings}
          tabState={tabState}
        />
      )}
      <SelectionPopover settings={settings} shortcutSignal={lookupSignal} />
      {!isFullscreen && (
        <ParagraphToolbar controller={controller} settings={settings} />
      )}
    </div>
  );
};

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'manual',
  runAt: 'document_idle',
  async main(ctx) {
    if (
      window.location.protocol !== 'http:' &&
      window.location.protocol !== 'https:' &&
      window.location.protocol !== 'file:'
    ) {
      return;
    }

    const initialSettings = await getSettings();

    if (isBrowserPdfDocument(document, window.location.href)) {
      const pdfTabState: PageTabState = {
        mode: 'original',
        hostname: window.location.hostname,
        translatedCount: 0,
        inFlightCount: 0,
        isPdf: true,
      };
      const openReader = () => {
        chrome.runtime
          .sendMessage({
            type: 'OPEN_PDF_READER',
            url: window.location.href,
          })
          .catch(() => {});
      };

      chrome.runtime.onMessage.addListener(
        (
          msg: RuntimeRequestMessage | { type: 'TOGGLE_PAGE_BILINGUAL' },
          _sender,
          sendResponse,
        ) => {
          if (!msg || typeof msg !== 'object') return false;
          if (msg.type === 'GET_TAB_STATE') {
            sendResponse(pdfTabState);
            return false;
          }
          if (
            msg.type === 'TOGGLE_PAGE_BILINGUAL' ||
            (msg.type === 'SET_TAB_VIEW_MODE' && msg.mode !== 'original')
          ) {
            openReader();
            sendResponse(pdfTabState);
            return false;
          }
          return false;
        },
      );

      window.addEventListener(
        'keydown',
        (e) => {
          if (
            !e.repeat &&
            matchesShortcut(e, initialSettings.shortcuts.toggleBilingual)
          ) {
            e.preventDefault();
            openReader();
          }
        },
        true,
      );

      const pdfUi = await createShadowRootUi(ctx, {
        name: BO_UI_HOST_TAG,
        css: contentUiCss.replaceAll(':root', ':host'),
        position: 'inline',
        anchor: 'body',
        append: 'last',
        onMount: (container, _shadow, shadowHost) => {
          shadowHost.classList.add('notranslate');
          shadowHost.setAttribute('translate', 'no');
          const root = ReactDOM.createRoot(container);
          const PdfEntryPill: React.FC = () => {
            const [dismissed, setDismissed] = useState(false);
            if (dismissed) return null;
            return (
              <div
                style={{
                  position: 'fixed',
                  top: '68px',
                  right: '22px',
                  zIndex: 2147483645,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '2px',
                  background: 'rgba(15, 23, 42, 0.92)',
                  color: '#fff',
                  borderRadius: '999px',
                  padding: '5px 6px 5px 12px',
                  boxShadow: '0 8px 24px -4px rgba(15, 23, 42, 0.35)',
                  border: '1px solid rgba(255, 255, 255, 0.14)',
                  fontSize: '12px',
                  fontWeight: 500,
                }}
              >
                <button
                  type="button"
                  onClick={openReader}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    color: '#fff',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: '6px',
                      height: '6px',
                      borderRadius: '999px',
                      background: '#3b82f6',
                    }}
                  />
                  <span>双语对照阅读 PDF</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDismissed(true)}
                  aria-label="关闭提示"
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    marginLeft: '4px',
                    padding: '2px 6px',
                    borderRadius: '999px',
                    color: 'rgba(255,255,255,0.65)',
                    fontSize: '13px',
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </div>
            );
          };
          root.render(<PdfEntryPill />);
          return root;
        },
        onRemove: (root) => {
          root?.unmount();
        },
      });

      pdfUi.mount();
      return;
    }

    const controller = new PageTranslationController(initialSettings);
    controller.init();

    const subtitleController = new SubtitleController(initialSettings);
    subtitleController.init();

    // Handle Popup & Context Menu messages
    chrome.runtime.onMessage.addListener(
      (
        msg: RuntimeRequestMessage | { type: 'TOGGLE_PAGE_BILINGUAL' },
        _sender,
        sendResponse,
      ) => {
        if (!msg || typeof msg !== 'object') return false;
        if (msg.type === 'GET_TAB_STATE') {
          sendResponse(controller.getState());
          return false;
        }
        if (msg.type === 'SET_TAB_VIEW_MODE') {
          controller.setMode(msg.mode);
          sendResponse(controller.getState());
          return false;
        }
        if (msg.type === 'TOGGLE_PAGE_BILINGUAL') {
          controller.toggleBilingual();
          sendResponse(controller.getState());
          return false;
        }
        return false;
      },
    );

    let detachFullscreenSync: (() => void) | null = null;

    const ui = await createShadowRootUi(ctx, {
      name: BO_UI_HOST_TAG,
      css: contentUiCss.replaceAll(':root', ':host'),
      position: 'inline',
      anchor: 'body',
      append: 'last',
      onMount: (container, _shadow, shadowHost) => {
        shadowHost.classList.add('notranslate');
        shadowHost.setAttribute('translate', 'no');

        const syncHostParentForFullscreen = () => {
          const fsEl = document.fullscreenElement;
          const targetParent =
            fsEl &&
            fsEl !== document.documentElement &&
            fsEl !== document.body &&
            fsEl.tagName !== 'VIDEO'
              ? fsEl
              : document.body;
          if (targetParent && shadowHost.parentElement !== targetParent) {
            targetParent.appendChild(shadowHost);
          }
        };
        document.addEventListener(
          'fullscreenchange',
          syncHostParentForFullscreen,
        );
        detachFullscreenSync = () => {
          document.removeEventListener(
            'fullscreenchange',
            syncHostParentForFullscreen,
          );
        };

        const root = ReactDOM.createRoot(container);
        root.render(
          <ContentApp
            controller={controller}
            subtitleController={subtitleController}
            initialSettings={initialSettings}
          />,
        );
        return root;
      },
      onRemove: (root) => {
        detachFullscreenSync?.();
        detachFullscreenSync = null;
        root?.unmount();
      },
    });

    ui.mount();
  },
});
