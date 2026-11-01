import type {
  ExtensionSettings,
  LanguageCode,
  ServicePresetType,
  ServiceProfile,
  TranslationStylePreset,
} from '../types';

export interface ServicePresetMeta {
  preset: ServicePresetType;
  label: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
}

export const SERVICE_PRESETS: ServicePresetMeta[] = [
  {
    preset: 'openai',
    label: 'OpenAI',
    description: 'OpenAI 官方接口（如 gpt-4o-mini / gpt-4.1-mini）',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresApiKey: true,
  },
  {
    preset: 'minimax',
    label: 'MiniMax',
    description: 'MiniMax 开放平台接口（https://api.minimax.cn/v1）',
    defaultBaseUrl: 'https://api.minimax.cn/v1',
    defaultModel: 'MiniMax-M2.5',
    requiresApiKey: true,
  },
  {
    preset: 'xiaomi-mimo',
    label: 'Xiaomi MiMo',
    description: '小米 MiMo 按量实时接口（https://api.xiaomimimo.com/v1）',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.6-flash',
    requiresApiKey: true,
  },
  {
    preset: 'xiaomi-mimo-token-plan',
    label: 'Xiaomi MiMo Token Plan',
    description: '小米 MiMo Token Plan 订阅接口（https://token-plan-cn.xiaomimimo.com/v1）',
    defaultBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.6-flash',
    requiresApiKey: true,
  },
  {
    preset: 'kimi',
    label: 'Kimi',
    description: 'Moonshot Kimi 开放平台接口（https://api.moonshot.cn/v1）',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    requiresApiKey: true,
  },
  {
    preset: 'kimi-code',
    label: 'Kimi Code',
    description: 'Kimi Code 订阅接口（https://api.kimi.com/coding/v1）',
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    defaultModel: 'kimi-for-coding',
    requiresApiKey: true,
  },
  {
    preset: 'ollama',
    label: 'Ollama 本地模型',
    description: '本地隐私零成本运行，自动免配置解决 403 跨域',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b',
    requiresApiKey: false,
  },
  {
    preset: 'custom',
    label: '自定义 OpenAI 兼容',
    description: '任意兼容 /v1/chat/completions 的自建或第三方服务',
    defaultBaseUrl: 'https://api.example.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresApiKey: true,
  },
];

export const LANGUAGE_OPTIONS: Array<{ code: LanguageCode; label: string; englishName: string }> = [
  { code: 'auto', label: '自动检测', englishName: 'Auto Detect' },
  { code: 'zh-CN', label: '简体中文', englishName: 'Simplified Chinese' },
  { code: 'zh-TW', label: '繁體中文', englishName: 'Traditional Chinese' },
  { code: 'en', label: 'English', englishName: 'English' },
  { code: 'ja', label: '日本語', englishName: 'Japanese' },
  { code: 'ko', label: '한국어', englishName: 'Korean' },
  { code: 'fr', label: 'Français', englishName: 'French' },
  { code: 'de', label: 'Deutsch', englishName: 'German' },
  { code: 'es', label: 'Español', englishName: 'Spanish' },
  { code: 'ru', label: 'Русский', englishName: 'Russian' },
];

export const STYLE_PRESET_OPTIONS: Array<{
  value: TranslationStylePreset;
  label: string;
  description: string;
}> = [
  {
    value: 'blockquote',
    label: '引线文档风',
    description: '左侧柔和色条 + 极浅底色，阅读技术文档层次最清晰',
  },
  {
    value: 'default',
    label: '默认纯净',
    description: '无额外装饰，自然继承原网页字体与排版',
  },
  {
    value: 'muted',
    label: '柔和弱化',
    description: '适度降低译文不透明度，突出原文主导地位',
  },
  {
    value: 'dashed',
    label: '虚线下划线',
    description: '底部清爽细虚线托底，适合高密度长文阅读',
  },
  {
    value: 'marker',
    label: '荧光马克笔',
    description: '暖色半高渐变底纹，重点段落一目了然',
  },
  {
    value: 'mask',
    label: '模糊遮罩',
    description: '默认轻度模糊，鼠标悬停时清晰显现（适合练外语）',
  },
];

export function createServiceFromPreset(
  preset: ServicePresetType,
  overrides: Partial<ServiceProfile> = {},
): ServiceProfile {
  const meta =
    SERVICE_PRESETS.find((item) => item.preset === preset) ??
    SERVICE_PRESETS[0]!;
  return {
    id: overrides.id ?? `svc_${ preset }_${ Math.random().toString(36).slice(2, 8) }`,
    name: overrides.name ?? meta.label,
    preset,
    baseUrl: overrides.baseUrl ?? meta.defaultBaseUrl,
    apiKey: overrides.apiKey ?? '',
    model: overrides.model ?? meta.defaultModel,
    enableGlossary: overrides.enableGlossary ?? true,
    suppressThinking: overrides.suppressThinking ?? true,
    maxConcurrency: overrides.maxConcurrency ?? 4,
    batchSize: overrides.batchSize ?? 6,
    temperature: overrides.temperature ?? 0.2,
    customSystemPrompt: overrides.customSystemPrompt ?? '',
    enabled: overrides.enabled ?? true,
  };
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  sourceLang: 'auto',
  targetLang: 'zh-CN',
  primaryServiceId: 'svc_default_ollama',
  selectionServiceId: 'follow-primary',
  comparisonServiceIds: [],
  stylePreset: 'blockquote',
  fontScale: 0.96,
  showSelectionTriggerIcon: true,
  shortcuts: {
    toggleBilingual: 'Alt+KeyA',
    toggleTranslatedOnly: 'Alt+KeyS',
    selectionLookup: 'Alt+KeyD',
    retranslateParagraph: 'Alt+KeyR',
    hoverModifier: 'Alt',
    enableMouseHoldHover: false,
  },
  floatingTab: {
    enabled: true,
    side: 'right',
    topRatio: 0.62,
  },
  services: [
    createServiceFromPreset('ollama', {
      id: 'svc_default_ollama',
      name: 'Ollama 本地模型',
    }),
    createServiceFromPreset('openai', {
      id: 'svc_default_openai',
      name: 'OpenAI',
    }),
  ],
  glossary: [
    {
      id: 'gls_hydration',
      source: 'hydration',
      target: '水合',
      strategy: 'translate',
      caseSensitive: false,
      note: 'SSR 前端框架注水/水合术语',
      enabled: true,
      createdAt: 1700000000000,
    },
    {
      id: 'gls_idempotent',
      source: 'idempotent',
      target: '幂等的',
      strategy: 'translate',
      caseSensitive: false,
      note: '分布式与接口设计高频词',
      enabled: true,
      createdAt: 1700000001000,
    },
    {
      id: 'gls_server_components',
      source: 'Server Components',
      target: '服务端组件',
      strategy: 'translate',
      caseSensitive: false,
      note: 'React 架构术语',
      enabled: true,
      createdAt: 1700000002000,
    },
    {
      id: 'gls_ollama',
      source: 'Ollama',
      target: '',
      strategy: 'keep',
      caseSensitive: true,
      note: '保持产品专有名词原文',
      enabled: true,
      createdAt: 1700000003000,
    },
  ],
  siteRules: [
    {
      id: 'rule_localhost',
      pattern: 'localhost',
      action: 'never-translate',
      hideFloatingTab: true,
      enabled: true,
    },
    {
      id: 'rule_127',
      pattern: '127.0.0.1',
      action: 'never-translate',
      hideFloatingTab: true,
      enabled: true,
    },
  ],
};
