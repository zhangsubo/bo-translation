import { describe, expect, it } from 'vitest';
import {
  buildGlossaryPromptSection,
  exportGlossaryCsv,
  lockKeepGlossaryTerms,
  matchGlossaryEntries,
  parseGlossaryImport,
  unlockKeepGlossaryTerms,
} from '../src/glossary';
import {
  buildProviderExtraParams,
  isBilibiliIndexService,
  normalizeOpenAIEndpoints,
} from '../src/providers/openai';
import { BatchLineStreamParser } from '../src/providers/stream-parser';
import { matchSiteRule, normalizeSettings } from '../src/storage';
import { createServiceFromPreset, SERVICE_PRESETS } from '../src/storage/defaults';
import type { GlossaryEntry, ServiceProfile, SiteRule } from '../src/types';

describe('Milestone 1: Glossary, Stream Parser & Endpoint Normalization', () => {
  const sampleGlossary: GlossaryEntry[] = [
    {
      id: '1',
      source: 'state',
      target: '状态',
      strategy: 'translate',
      caseSensitive: false,
      enabled: true,
      createdAt: 1,
    },
    {
      id: '2',
      source: 'Server Components',
      target: '服务端组件',
      strategy: 'translate',
      caseSensitive: false,
      enabled: true,
      createdAt: 2,
    },
    {
      id: '3',
      source: 'Ollama',
      target: '',
      strategy: 'keep',
      caseSensitive: true,
      enabled: true,
      createdAt: 3,
    },
  ];

  it('matches glossary entries with word boundaries and case-sensitivity', () => {
    // "statement" must NOT trigger "state"
    const miss = matchGlossaryEntries(['This statement is clear.'], sampleGlossary);
    expect(miss).toHaveLength(0);

    // "ollama" lowercase should NOT match case-sensitive "Ollama"
    const caseMiss = matchGlossaryEntries(['run ollama locally'], sampleGlossary);
    expect(caseMiss).toHaveLength(0);

    const hit = matchGlossaryEntries(
      ['React Server Components manage state with Ollama.'],
      sampleGlossary,
    );
    expect(hit.map((e) => e.source)).toEqual([
      'Server Components',
      'Ollama',
      'state',
    ]);

    const promptBlock = buildGlossaryPromptSection(hit);
    expect(promptBlock).toContain('"Server Components" -> "服务端组件"');
    expect(promptBlock).toContain('keep original "Ollama" untranslated');
  });

  it('locks and unlocks keep-strategy glossary terms without touching {{0}} or <a0>', () => {
    const matched = matchGlossaryEntries(['Deploy Ollama with {{0}}'], sampleGlossary);
    const { lockedText, keepMap } = lockKeepGlossaryTerms(
      'Deploy <a0>Ollama</a0> with {{0}} and Ollama CLI.',
      matched,
    );
    expect(lockedText).toBe(
      'Deploy <a0>{{K0}}</a0> with {{0}} and {{K1}} CLI.',
    );

    const unlocked = unlockKeepGlossaryTerms(
      '使用 {{0}} 和 {{K1}} CLI 部署 <a0>{{K0}}</a0>。',
      keepMap,
    );
    expect(unlocked).toBe(
      '使用 {{0}} 和 Ollama CLI 部署 <a0>Ollama</a0>。',
    );
  });

  it('exports and imports glossary CSV and JSON cleanly', () => {
    const csv = exportGlossaryCsv(sampleGlossary);
    const imported = parseGlossaryImport(csv);
    expect(imported).toHaveLength(3);
    expect(imported[0]?.source).toBe('state');
    expect(imported[2]?.strategy).toBe('keep');
    expect(imported[2]?.caseSensitive).toBe(true);
  });

  it('streams multi-item ID | text chunks while stripping <think> blocks and detecting missing IDs', () => {
    const deltas: Array<[number, string]> = [];
    const dones: Array<[number, string]> = [];

    const parser = new BatchLineStreamParser([0, 1, 2], {
      onDelta: (id, text) => deltas.push([id, text]),
      onDone: (id, text) => dones.push([id, text]),
    });

    parser.push('<think>Let me analyze ');
    expect(deltas).toHaveLength(0);
    parser.push('terminology first.</think>\n0 | 第一段');
    expect(deltas.at(-1)).toEqual([0, '第一段']);

    parser.push('完整译文\n2 | 跳过了1直接输出第三段');
    expect(dones).toContainEqual([0, '第一段完整译文']);

    const completed = parser.finalize();
    expect(completed.has(0)).toBe(true);
    expect(completed.has(1)).toBe(false); // Missing ID 1 detected for budgeted fallback!
    expect(completed.has(2)).toBe(true);
    expect(dones).toContainEqual([2, '跳过了1直接输出第三段']);
  });

  it('falls back gracefully when a small local model omits 0 | on single-item requests', () => {
    const dones: Array<[number, string]> = [];
    const parser = new BatchLineStreamParser([0], {
      onDone: (id, text) => dones.push([id, text]),
    });

    parser.push('这是没有带编号前缀的单段本地模型译文。');
    const completed = parser.finalize();
    expect(completed.has(0)).toBe(true);
    expect(dones).toEqual([[0, '这是没有带编号前缀的单段本地模型译文。']]);
  });

  it('normalizes OpenAI-compatible and local Ollama endpoints accurately', () => {
    const ollama = normalizeOpenAIEndpoints('http://localhost:11434');
    expect(ollama.isLocal).toBe(true);
    expect(ollama.chatUrl).toBe('http://localhost:11434/v1/chat/completions');
    expect(ollama.ollamaTagsUrl).toBe('http://localhost:11434/api/tags');

    const minimax = normalizeOpenAIEndpoints('https://api.minimax.cn/v1/');
    expect(minimax.isLocal).toBe(false);
    expect(minimax.chatUrl).toBe('https://api.minimax.cn/v1/chat/completions');

    const mimoTokenPlan = normalizeOpenAIEndpoints(
      'https://token-plan-cn.xiaomimimo.com/v1',
    );
    expect(mimoTokenPlan.chatUrl).toBe(
      'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
    );

    const kimiCode = normalizeOpenAIEndpoints('https://api.kimi.com/coding/v1');
    expect(kimiCode.chatUrl).toBe(
      'https://api.kimi.com/coding/v1/chat/completions',
    );
    expect(kimiCode.modelsUrl).toBe('https://api.kimi.com/coding/v1/models');
  });

  it('prioritizes exact hostname site rules over wildcard rules', () => {
    const rules: SiteRule[] = [
      {
        id: '1',
        pattern: '*.react.dev',
        action: 'always-bilingual',
        hideFloatingTab: false,
        enabled: true,
      },
      {
        id: '2',
        pattern: 'playground.react.dev',
        action: 'never-translate',
        hideFloatingTab: true,
        enabled: true,
      },
    ];
    expect(matchSiteRule('zh-hans.react.dev', rules)?.action).toBe('always-bilingual');
    expect(matchSiteRule('playground.react.dev', rules)?.action).toBe('never-translate');
  });

  it('orders built-in presets cleanly and migrates legacy removed presets', () => {
    expect(SERVICE_PRESETS.map((p) => p.preset)).toEqual([
      'bilibili-index',
      'openai',
      'minimax',
      'xiaomi-mimo',
      'xiaomi-mimo-token-plan',
      'kimi',
      'kimi-code',
      'ollama',
      'custom',
    ]);

    const legacyEmpty = {
      ...createServiceFromPreset('custom', { id: 'svc_old_empty', apiKey: '' }),
      preset: 'deepseek' as unknown as ServiceProfile['preset'],
    };
    const legacyWithKey = {
      ...createServiceFromPreset('custom', { id: 'svc_old_key', apiKey: 'sk-user-key' }),
      preset: 'openrouter' as unknown as ServiceProfile['preset'],
    };
    const ollamaSvc = createServiceFromPreset('ollama', { id: 'svc_ollama' });

    const normalized = normalizeSettings({
      primaryServiceId: 'svc_old_empty',
      services: [ollamaSvc, legacyEmpty, legacyWithKey],
    });

    expect(normalized.services.map((s) => s.id)).toEqual(['svc_ollama', 'svc_old_key']);
    expect(normalized.services[1]?.preset).toBe('custom');
    expect(normalized.primaryServiceId).toBe('svc_ollama');
  });

  it('configures Bilibili Index-Translate preset with call_api.py defaults and enable_thinking toggle', () => {
    const biliMeta = SERVICE_PRESETS.find((p) => p.preset === 'bilibili-index');
    expect(biliMeta?.requiresApiKey).toBe(false);
    expect(biliMeta?.description).toContain('感谢阿B限时免费接口');

    const biliSvc = createServiceFromPreset('bilibili-index');
    expect(biliSvc.baseUrl).toBe('https://index-translate.bilibili.com/v1');
    expect(biliSvc.model).toBe('Index-Translate-35B-A3B');
    expect(biliSvc.temperature).toBe(0);
    expect(biliSvc.maxConcurrency).toBe(3);
    expect(isBilibiliIndexService(biliSvc)).toBe(true);

    expect(buildProviderExtraParams(biliSvc)).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(
      buildProviderExtraParams({ ...biliSvc, suppressThinking: false }),
    ).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    });

    const ep = normalizeOpenAIEndpoints(biliSvc.baseUrl);
    expect(ep.chatUrl).toBe(
      'https://index-translate.bilibili.com/v1/chat/completions',
    );
    expect(ep.modelsUrl).toBe('https://index-translate.bilibili.com/v1/models');
  });
});
