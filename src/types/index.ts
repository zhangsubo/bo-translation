export type PageViewMode = 'original' | 'bilingual' | 'translated-only';

export type TranslationStylePreset =
  | 'default'
  | 'muted'
  | 'blockquote'
  | 'dashed'
  | 'marker'
  | 'mask';

export type LanguageCode =
  | 'auto'
  | 'zh-CN'
  | 'zh-TW'
  | 'en'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'ru';

export type TargetLanguageCode = Exclude<LanguageCode, 'auto'>;

export type ServicePresetType =
  | 'openai'
  | 'minimax'
  | 'xiaomi-mimo'
  | 'xiaomi-mimo-token-plan'
  | 'kimi'
  | 'kimi-code'
  | 'ollama'
  | 'custom';

export interface ServiceProfile {
  id: string;
  name: string;
  preset: ServicePresetType;
  baseUrl: string;
  apiKey: string;
  model: string;
  enableGlossary: boolean;
  suppressThinking: boolean;
  maxConcurrency: number;
  batchSize: number;
  temperature: number;
  customSystemPrompt?: string;
  enabled: boolean;
}

export type GlossaryStrategy = 'translate' | 'keep';

export interface GlossaryEntry {
  id: string;
  source: string;
  target: string;
  strategy: GlossaryStrategy;
  caseSensitive: boolean;
  note?: string;
  enabled: boolean;
  createdAt: number;
}

export type HoverModifierKey = 'Alt' | 'Control' | 'Shift' | 'Meta' | 'None';

export interface ShortcutConfig {
  toggleBilingual: string;
  toggleTranslatedOnly: string;
  selectionLookup: string;
  retranslateParagraph: string;
  hoverModifier: HoverModifierKey;
  enableMouseHoldHover: boolean;
}

export interface FloatingTabConfig {
  enabled: boolean;
  side: 'right' | 'left';
  topRatio: number;
}

export type SiteRuleAction =
  | 'none'
  | 'always-bilingual'
  | 'always-translated-only'
  | 'never-translate';

export interface SiteRule {
  id: string;
  pattern: string;
  action: SiteRuleAction;
  hideFloatingTab: boolean;
  customSelectors?: string;
  excludeSelectors?: string;
  enabled: boolean;
}

export interface ExtensionSettings {
  sourceLang: LanguageCode;
  targetLang: TargetLanguageCode;
  primaryServiceId: string;
  selectionServiceId: string; // 'follow-primary' or ServiceProfile.id
  comparisonServiceIds: string[];
  stylePreset: TranslationStylePreset;
  fontScale: number;
  showSelectionTriggerIcon: boolean;
  shortcuts: ShortcutConfig;
  floatingTab: FloatingTabConfig;
  services: ServiceProfile[];
  glossary: GlossaryEntry[];
  siteRules: SiteRule[];
}

export interface BatchTranslateItem {
  id: number;
  text: string;
  plainText: string;
}

export type StreamPortClientMessage =
  | {
      type: 'TRANSLATE_BATCH';
      requestId: string;
      serviceId?: string;
      docTitle?: string;
      sourceLang?: LanguageCode;
      targetLang?: TargetLanguageCode;
      items: BatchTranslateItem[];
    }
  | {
      type: 'SELECTION_LOOKUP';
      requestId: string;
      serviceId?: string;
      selectedText: string;
      contextText: string;
      docTitle?: string;
      isWordOrPhrase: boolean;
      sourceLang?: LanguageCode;
      targetLang?: TargetLanguageCode;
    }
  | {
      type: 'CANCEL_REQUEST';
      requestId: string;
    };

export type StreamPortServerMessage =
  | {
      type: 'ITEM_DELTA';
      requestId: string;
      id: number;
      fullText: string;
      serviceId: string;
      serviceName: string;
    }
  | {
      type: 'ITEM_DONE';
      requestId: string;
      id: number;
      fullText: string;
      serviceId: string;
      serviceName: string;
    }
  | {
      type: 'ITEM_ERROR';
      requestId: string;
      id: number;
      error: string;
    }
  | {
      type: 'BATCH_COMPLETE';
      requestId: string;
    }
  | {
      type: 'LOOKUP_DELTA';
      requestId: string;
      serviceId: string;
      serviceName: string;
      fullText: string;
    }
  | {
      type: 'LOOKUP_DONE';
      requestId: string;
      serviceId: string;
      serviceName: string;
      fullText: string;
    }
  | {
      type: 'LOOKUP_ERROR';
      requestId: string;
      serviceId: string;
      serviceName: string;
      error: string;
    };

export type RuntimeRequestMessage =
  | { type: 'TEST_SERVICE'; service: ServiceProfile }
  | { type: 'FETCH_MODELS'; baseUrl: string; apiKey: string }
  | { type: 'GET_TAB_STATE' }
  | { type: 'SET_TAB_VIEW_MODE'; mode: PageViewMode }
  | { type: 'OPEN_OPTIONS_PAGE'; tab?: string };

export interface PageTabState {
  mode: PageViewMode;
  hostname: string;
  translatedCount: number;
  inFlightCount: number;
}
