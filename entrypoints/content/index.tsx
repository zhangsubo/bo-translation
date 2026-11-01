import './style.css';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
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

interface ContentAppProps {
  controller: PageTranslationController;
  initialSettings: ExtensionSettings;
}

const ContentApp: React.FC<ContentAppProps> = ({
  controller,
  initialSettings,
}) => {
  const [settings, setSettings] = useState<ExtensionSettings>(initialSettings);
  const [tabState, setTabState] = useState<PageTabState>(() =>
    controller.getState(),
  );
  const [lookupSignal, setLookupSignal] = useState(0);

  useEffect(() => {
    const unsubSettings = subscribeSettings((next) => {
      controller.updateSettings(next);
      setSettings(next);
    });
    const unsubState = controller.subscribeState((nextState) => {
      setTabState(nextState);
    });
    return () => {
      unsubSettings();
      unsubState();
    };
  }, [controller]);

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
      <FloatingTab
        controller={controller}
        settings={settings}
        tabState={tabState}
      />
      <SelectionPopover settings={settings} shortcutSignal={lookupSignal} />
      <ParagraphToolbar controller={controller} settings={settings} />
    </div>
  );
};

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
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
    const controller = new PageTranslationController(initialSettings);
    controller.init();

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

    const ui = await createShadowRootUi(ctx, {
      name: BO_UI_HOST_TAG,
      position: 'inline',
      anchor: 'body',
      append: 'last',
      onMount: (container, shadow, shadowHost) => {
        shadowHost.classList.add('notranslate');
        shadowHost.setAttribute('translate', 'no');
        const root = ReactDOM.createRoot(container);
        root.render(
          <ContentApp
            controller={controller}
            initialSettings={initialSettings}
          />,
        );
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
      },
    });

    ui.mount();
  },
});
