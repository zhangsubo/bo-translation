import {
  buildGlossaryPromptSection,
  lockKeepGlossaryTerms,
  matchGlossaryEntries,
  unlockKeepGlossaryTerms,
} from '../glossary';
import { LANGUAGE_OPTIONS } from '../storage/defaults';
import type {
  BatchTranslateItem,
  GlossaryEntry,
  LanguageCode,
  ServiceProfile,
  TargetLanguageCode,
} from '../types';
import { BatchLineStreamParser, stripThinkingBlocks } from './stream-parser';

export interface NormalizedEndpoints {
  origin: string;
  chatUrl: string;
  modelsUrl: string;
  ollamaTagsUrl: string;
  isLocal: boolean;
}

export function isLocalEndpoint(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return (
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '0.0.0.0' ||
      u.hostname === '[::1]' ||
      u.hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}

export function normalizeOpenAIEndpoints(rawBaseUrl: string): NormalizedEndpoints {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, '');
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${ trimmed }`;

  const parsed = new URL(withProtocol);
  const origin = parsed.origin;
  const isLocal = isLocalEndpoint(withProtocol);

  let base = withProtocol;
  if (base.endsWith('/chat/completions')) {
    base = base.slice(0, -'/chat/completions'.length);
  } else if (
    parsed.pathname === '' ||
    parsed.pathname === '/'
  ) {
    base = `${ origin }/v1`;
  }

  return {
    origin,
    chatUrl: `${ base }/chat/completions`,
    modelsUrl: `${ base }/models`,
    ollamaTagsUrl: `${ origin }/api/tags`,
    isLocal,
  };
}

function getEnglishLanguageName(code: LanguageCode | TargetLanguageCode): string {
  return (
    LANGUAGE_OPTIONS.find((item) => item.code === code)?.englishName ?? code
  );
}

function buildProviderExtraParams(service: ServiceProfile): Record<string, unknown> {
  if (!service.suppressThinking) return {};

  const host = service.baseUrl.toLowerCase();
  const model = service.model.toLowerCase();

  if (host.includes('xiaomimimo.com')) {
    return { thinking: { type: 'disabled' } };
  }
  if (
    host.includes('api.openai.com') &&
    (model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
  ) {
    return { reasoning_effort: 'low' };
  }
  return {};
}

export function buildBatchTranslationMessages(params: {
  items: Array<{ id: number; text: string }>;
  sourceLang: LanguageCode;
  targetLang: TargetLanguageCode;
  docTitle?: string;
  glossarySection?: string;
  customSystemPrompt?: string;
}): Array<{ role: 'system' | 'user'; content: string }> {
  const fromStr =
    params.sourceLang === 'auto'
      ? 'the source language'
      : getEnglishLanguageName(params.sourceLang);
  const toStr = getEnglishLanguageName(params.targetLang);

  const systemParts = [
    `You are an expert ${ toStr } translator specializing in technical documentation and articles. Translate from ${ fromStr } into natural, accurate, idiomatic ${ toStr }.`,
    '',
    'Strict Formatting Rules:',
    '1. Each input segment starts with `ID | text`. Output ONLY `ID | translated_text` in the exact same order, one segment per line. Never output markdown code fences or extra commentary.',
    '2. Preserve opaque tokens such as `{{0}}`, `{{1}}`, `{{K0}}`, and `<br>` EXACTLY as written — never delete, translate, or alter them.',
    '3. Preserve inline wrapper tags such as `<a0>...</a0>`, `<a1>...</a1>` around the corresponding translated words with valid nesting.',
    '4. Keep programming identifiers, CLI flags, API paths, and package names intact when appropriate.',
    '5. Translate short headings, navigation labels, or single phrases directly without asking for more context.',
  ];

  if (params.docTitle?.trim()) {
    systemParts.push('', `Document Context Title: ${ params.docTitle.trim() }`);
  }

  if (params.glossarySection?.trim()) {
    systemParts.push('', params.glossarySection.trim());
  }

  if (params.customSystemPrompt?.trim()) {
    systemParts.push('', `Additional Instructions: ${ params.customSystemPrompt.trim() }`);
  }

  const userContent = params.items
    .map((item) => `${ item.id } | ${ item.text.replace(/\r?\n/g, '<br>') }`)
    .join('\n');

  return [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: userContent },
  ];
}

export function buildSelectionLookupMessages(params: {
  selectedText: string;
  contextText: string;
  isWordOrPhrase: boolean;
  sourceLang: LanguageCode;
  targetLang: TargetLanguageCode;
  docTitle?: string;
  glossarySection?: string;
}): Array<{ role: 'system' | 'user'; content: string }> {
  const toStr = getEnglishLanguageName(params.targetLang);

  if (params.isWordOrPhrase) {
    const systemParts = [
      `You are a concise, context-aware technical & reading dictionary outputting in ${ toStr }.`,
      'Explain the selected word or phrase accurately based on its surrounding sentence context.',
      'Format your response cleanly in 3 short lines (no markdown code fences):',
      '【语境释义】<The exact meaning in this specific context, concise and direct>',
      '【词性音标】<IPA phonetic (if English) & part of speech or acronym expansion>',
      '【补充说明】<1-2 brief sentences on common meanings or technical usage in this context>',
    ];
    if (params.glossarySection) {
      systemParts.push('', params.glossarySection);
    }

    const userParts = [`Selected term: ${ params.selectedText.trim() }`];
    if (params.contextText?.trim() && params.contextText.trim() !== params.selectedText.trim()) {
      userParts.push(`Context paragraph: ${ params.contextText.trim() }`);
    }
    if (params.docTitle?.trim()) {
      userParts.push(`Page title: ${ params.docTitle.trim() }`);
    }

    return [
      { role: 'system', content: systemParts.join('\n') },
      { role: 'user', content: userParts.join('\n') },
    ];
  }

  const systemParts = [
    `You are an expert ${ toStr } translator. Translate the selected passage into natural, accurate ${ toStr }, taking the surrounding context into account.`,
    'Output ONLY the translation directly without explanations or quotes.',
  ];
  if (params.glossarySection) {
    systemParts.push('', params.glossarySection);
  }

  const userParts = [`Selected text:\n${ params.selectedText.trim() }`];
  if (
    params.contextText?.trim() &&
    params.contextText.trim() !== params.selectedText.trim()
  ) {
    userParts.push(`\nSurrounding context (for reference only, do NOT translate this part):\n${ params.contextText.trim() }`);
  }

  return [
    { role: 'system', content: systemParts.join('\n') },
    { role: 'user', content: userParts.join('\n') },
  ];
}

export async function streamOpenAIChat(params: {
  service: ServiceProfile;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  signal?: AbortSignal;
  onChunk: (deltaContent: string) => void;
}): Promise<string> {
  const { service, messages, signal, onChunk } = params;
  const endpoints = normalizeOpenAIEndpoints(service.baseUrl);

  if (!endpoints.isLocal && !service.apiKey.trim()) {
    throw new Error(`服务「${ service.name }」尚未填写 API Key`);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (service.apiKey.trim()) {
    headers.Authorization = `Bearer ${ service.apiKey.trim() }`;
  }

  const modelLower = service.model.toLowerCase();
  const chatUrlLower = endpoints.chatUrl.toLowerCase();
  const shouldOmitTemperature =
    (chatUrlLower.includes('api.openai.com') &&
      (modelLower.startsWith('o1') ||
        modelLower.startsWith('o3') ||
        modelLower.startsWith('o4'))) ||
    chatUrlLower.includes('/coding/') ||
    modelLower.includes('kimi-for-coding') ||
    modelLower.startsWith('kimi-k2.5') ||
    modelLower.startsWith('kimi-k3');

  const rawTemp = service.temperature ?? 0.2;
  const resolvedTemperature = chatUrlLower.includes('minimax')
    ? Math.max(0.1, Math.min(1.0, rawTemp || 0.2))
    : rawTemp;

  const bodyPayload: Record<string, unknown> = {
    model: service.model.trim(),
    messages,
    stream: true,
    ...(shouldOmitTemperature ? {} : { temperature: resolvedTemperature }),
    ...buildProviderExtraParams(service),
  };

  const response = await fetch(endpoints.chatUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyPayload),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    let detail = errText.slice(0, 240);
    try {
      const errJson = JSON.parse(errText);
      detail = errJson?.error?.message || errJson?.message || detail;
    } catch {
      // keep raw snippet
    }
    throw new Error(
      `HTTP ${ response.status } (${ service.name }): ${ detail || response.statusText }`,
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  // Fallback when server ignores stream:true and returns plain JSON
  if (!response.body || contentType.includes('application/json')) {
    const json = await response.json();
    const content: string = json?.choices?.[0]?.message?.content ?? '';
    if (content) {
      onChunk(content);
    }
    return content;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let sseBuffer = '';
  let accumulated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    const lines = sseBuffer.split(/\r?\n/);
    sseBuffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(dataStr);
        const delta =
          parsed?.choices?.[0]?.delta?.content ??
          parsed?.message?.content ??
          '';
        if (typeof delta === 'string' && delta.length > 0) {
          accumulated += delta;
          onChunk(delta);
        }
      } catch {
        // Ignore partial or keepalive comments
      }
    }
  }

  return accumulated;
}

export async function executeBatchTranslation(params: {
  service: ServiceProfile;
  items: BatchTranslateItem[];
  glossary: GlossaryEntry[];
  sourceLang: LanguageCode;
  targetLang: TargetLanguageCode;
  docTitle?: string;
  signal?: AbortSignal;
  onItemDelta: (id: number, text: string) => void;
  onItemDone: (id: number, text: string) => void;
}): Promise<{ completedIds: Set<number> }> {
  const {
    service,
    items,
    glossary,
    sourceLang,
    targetLang,
    docTitle,
    signal,
    onItemDelta,
    onItemDone,
  } = params;

  const matchedGlossary = service.enableGlossary
    ? matchGlossaryEntries(
        items.map((it) => it.plainText || it.text),
        glossary,
      )
    : [];

  const glossarySection = buildGlossaryPromptSection(matchedGlossary);
  const keepMaps = new Map<number, Map<string, string>>();

  const preparedItems = items.map((item) => {
    if (matchedGlossary.length === 0) {
      return { id: item.id, text: item.text };
    }
    const { lockedText, keepMap } = lockKeepGlossaryTerms(
      item.text,
      matchedGlossary,
    );
    keepMaps.set(item.id, keepMap);
    return { id: item.id, text: lockedText };
  });

  const parser = new BatchLineStreamParser(
    items.map((it) => it.id),
    {
      onDelta: (id, rawText) => {
        const keepMap = keepMaps.get(id);
        const unlocked = keepMap
          ? unlockKeepGlossaryTerms(rawText, keepMap)
          : rawText;
        onItemDelta(id, unlocked);
      },
      onDone: (id, rawText) => {
        const keepMap = keepMaps.get(id);
        const unlocked = keepMap
          ? unlockKeepGlossaryTerms(rawText, keepMap)
          : rawText;
        onItemDone(id, unlocked);
      },
    },
  );

  const messages = buildBatchTranslationMessages({
    items: preparedItems,
    sourceLang,
    targetLang,
    docTitle,
    glossarySection,
    customSystemPrompt: service.customSystemPrompt,
  });

  await streamOpenAIChat({
    service,
    messages,
    signal,
    onChunk: (chunk) => parser.push(chunk),
  });

  const completedIds = parser.finalize();
  return { completedIds };
}

export async function executeSelectionLookup(params: {
  service: ServiceProfile;
  selectedText: string;
  contextText: string;
  isWordOrPhrase: boolean;
  glossary: GlossaryEntry[];
  sourceLang: LanguageCode;
  targetLang: TargetLanguageCode;
  docTitle?: string;
  signal?: AbortSignal;
  onDelta: (fullText: string) => void;
}): Promise<string> {
  const matchedGlossary = params.service.enableGlossary
    ? matchGlossaryEntries(
        [params.selectedText, params.contextText],
        params.glossary,
      )
    : [];

  const glossarySection = buildGlossaryPromptSection(matchedGlossary);
  const messages = buildSelectionLookupMessages({
    selectedText: params.selectedText,
    contextText: params.contextText,
    isWordOrPhrase: params.isWordOrPhrase,
    sourceLang: params.sourceLang,
    targetLang: params.targetLang,
    docTitle: params.docTitle,
    glossarySection,
  });

  let rawAccumulated = '';
  await streamOpenAIChat({
    service: params.service,
    messages,
    signal: params.signal,
    onChunk: (delta) => {
      rawAccumulated += delta;
      const { clean, isInsideThink } = stripThinkingBlocks(rawAccumulated);
      if (!isInsideThink || clean.trim()) {
        params.onDelta(clean.trimStart());
      }
    },
  });

  return stripThinkingBlocks(rawAccumulated).clean.trim();
}

export async function fetchAvailableModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const endpoints = normalizeOpenAIEndpoints(baseUrl);
  const headers: Record<string, string> = {};
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${ apiKey.trim() }`;
  }

  try {
    const res = await fetch(endpoints.modelsUrl, { headers });
    if (res.ok) {
      const json = await res.json();
      const list = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.models)
          ? json.models
          : [];
      const ids = list
        .map((m: { id?: string; name?: string }) => m.id || m.name || '')
        .filter(Boolean);
      if (ids.length > 0) {
        return Array.from(new Set(ids));
      }
    }
  } catch {
    // Fallback to Ollama native /api/tags if local
  }

  if (endpoints.isLocal) {
    const res = await fetch(endpoints.ollamaTagsUrl);
    if (res.ok) {
      const json = await res.json();
      const models = Array.isArray(json?.models) ? json.models : [];
      return models
        .map((m: { name?: string; model?: string }) => m.name || m.model || '')
        .filter(Boolean);
    }
  }

  throw new Error('无法拉取模型列表，请检查地址、密钥或服务是否已启动');
}

export async function testServiceConnectivity(
  service: ServiceProfile,
): Promise<{ ok: boolean; latencyMs: number; sampleOutput: string }> {
  const start = Date.now();
  let output = '';
  await streamOpenAIChat({
    service,
    messages: [
      {
        role: 'system',
        content: 'Translate to Simplified Chinese. Output only the translation.',
      },
      { role: 'user', content: 'Hello world' },
    ],
    onChunk: (delta) => {
      output += delta;
    },
  });
  const clean = stripThinkingBlocks(output).clean.trim();
  return {
    ok: clean.length > 0,
    latencyMs: Date.now() - start,
    sampleOutput: clean,
  };
}
