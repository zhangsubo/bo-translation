import { describe, expect, it, vi } from 'vitest';
import { PageTranslationController } from '../entrypoints/content/dom/controller';
import { parseCodeCommentText } from '../entrypoints/content/dom/github-comments';
import {
  applyViewModeToSegment,
  mountSegmentWrapper,
  updateSegmentTranslation,
} from '../entrypoints/content/dom/renderer';
import { scanTranslatableSegments } from '../entrypoints/content/dom/scanner';
import { serializeNodeGroup } from '../entrypoints/content/dom/serializer';
import { clearAllSiblingTypography } from '../entrypoints/content/dom/typography-sync';
import { detectIsForeignPage } from '../src/auto-translate/detector';
import {
  contrastRatio,
  parseCssColor,
  resolveAdaptiveTranslationColor,
} from '../src/dom-style/adaptive-contrast';
import { executeBatchWithThreeStageProtection } from '../src/providers/openai';
import {
  reassembleProseFragments,
  splitIntoProseFragments,
  validateProtectedTranslation,
} from '../src/providers/protected-text';
import { DEFAULT_SETTINGS } from '../src/storage/defaults';
import {
  formatSubtitleOffset,
  parseLocalSubtitleFile,
} from '../src/subtitle/local-parser';
import {
  NativeFullscreenVttRenderer,
  rankCandidateVideos,
} from '../src/subtitle/video-detector';

describe('Milestone 5: WuPage 1-5 Enhancements', () => {
  it('WuPage #1: validates protected placeholders and recovers damaged tokens via 3-stage prose fragment fallback', async () => {
    const source = 'Call {{0}} inside <a0>official docs</a0> when {{K0}} changes.';

    expect(
      validateProtectedTranslation(
        source,
        '当 {{K0}} 变化时，在<a0>官方文档</a0>中调用 {{0}}。',
      ),
    ).toBe(true);
    // Missing {{0}} -> invalid
    expect(
      validateProtectedTranslation(
        source,
        '当 {{K0}} 变化时，在<a0>官方文档</a0>中调用 useEffect。',
      ),
    ).toBe(false);
    // Swapped closing tag -> invalid
    expect(
      validateProtectedTranslation(
        source,
        '当 {{K0}} 变化时，在</a0>官方文档<a0>中调用 {{0}}。',
      ),
    ).toBe(false);

    const plan = splitIntoProseFragments(source);
    expect(plan.fragments).toEqual([
      'Call',
      'inside',
      'official docs',
      'when',
      'changes.',
    ]);
    const reassembled = reassembleProseFragments(
      plan,
      new Map([
        [0, '调用'],
        [1, '位于'],
        [2, '官方文档'],
        [3, '当'],
        [4, '变化时。'],
      ]),
    );
    expect(reassembled).toContain('{{0}}');
    expect(reassembled).toContain('{{K0}}');
    expect(reassembled).toContain('<a0>官方文档</a0>');

    // Full 3-stage orchestrator test: simulate a weak small model that drops {{0}} in Stage 1 & Stage 2,
    // then succeeds in Stage 3 when given pure-prose fragments without any placeholders!
    let callCount = 0;
    const doneResults = new Map<number, string>();
    const errors = new Map<number, string>();

    await executeBatchWithThreeStageProtection({
      service: {
        ...DEFAULT_SETTINGS.services[0]!,
        enableGlossary: true,
      },
      items: [
        {
          id: 1,
          text: 'Pass {{0}} to Hydration boundary.',
          plainText: 'Pass props to Hydration boundary.',
        },
        {
          id: 2,
          text: 'Everything works smoothly.',
          plainText: 'Everything works smoothly.',
        },
      ],
      glossary: [
        {
          id: 'g1',
          source: 'Hydration',
          target: '',
          strategy: 'keep',
          caseSensitive: false,
          enabled: true,
          createdAt: 0,
        },
      ],
      sourceLang: 'auto',
      targetLang: 'zh-CN',
      runLimited: (fn) => fn(),
      onItemDelta: () => {},
      onItemDone: (id, text) => doneResults.set(id, text),
      onItemError: (id, err) => errors.set(id, err),
      chatRunner: async ({ onChunk }) => {
        callCount++;
        if (callCount === 1) {
          // Stage 1 batch: item 2 succeeds, item 1 drops {{0}} and {{K0}}!
          const stage1Out = '1 | 将属性传递给水合边界。\n2 | 一切运行顺畅。\n';
          onChunk(stage1Out);
          return stage1Out;
        }
        if (callCount === 2) {
          // Stage 2 single-item retry for item 1: model still drops {{0}} and {{K0}}!
          const stage2Out = '1 | 将属性传递给水合边界。\n';
          onChunk(stage2Out);
          return stage2Out;
        }
        // Stage 3: pure prose fragments (`0 | Pass`, `1 | to`, `2 | boundary.`)
        const stage3Out = '0 | 传递\n1 | 到\n2 | 边界。\n';
        onChunk(stage3Out);
        return stage3Out;
      },
    });

    expect(callCount).toBe(3);
    expect(errors.size).toBe(0);
    expect(doneResults.get(2)).toBe('一切运行顺畅。');
    const recovered = doneResults.get(1) ?? '';
    expect(recovered).toContain('{{0}}');
    expect(recovered).toContain('Hydration');
  });

  it('WuPage #2: guarantees WCAG >= 4.6:1 adaptive contrast on dark/light backgrounds and mounts sibling wrapper for clamped cards', () => {
    const darkBg = 'rgb(18, 18, 24)';
    const darkAdapted = resolveAdaptiveTranslationColor(
      'rgb(228, 228, 235)',
      darkBg,
      'adaptive',
    );
    expect(darkAdapted).not.toBeNull();
    expect(
      contrastRatio(parseCssColor(darkAdapted!)!, parseCssColor(darkBg)!),
    ).toBeGreaterThanOrEqual(4.6);

    const lightBg = 'rgb(255, 255, 255)';
    const lightAdapted = resolveAdaptiveTranslationColor(
      'rgb(30, 41, 59)',
      lightBg,
      'adaptive',
    );
    expect(lightAdapted).not.toBeNull();
    expect(
      contrastRatio(parseCssColor(lightAdapted!)!, parseCssColor(lightBg)!),
    ).toBeGreaterThanOrEqual(4.6);

    expect(
      resolveAdaptiveTranslationColor('rgb(30, 41, 59)', lightBg, 'inherit'),
    ).toBeNull();

    // Clamped card title (`line-clamp-2`): mounts `<bo-trans data-bo-sibling="true">` outside `<h3>`
    document.body.innerHTML = `
      <article id="card">
        <h3 id="clamped-title" class="line-clamp-2" style="font-size: 20px; font-weight: 700;">
          Building Resilient Distributed Systems at Global Scale
        </h3>
      </article>
    `;
    const h3 = document.getElementById('clamped-title')!;
    const sourceNodes = Array.from(h3.childNodes);
    const handle = mountSegmentWrapper({
      id: 10,
      hostEl: h3,
      sourceNodes,
      serialized: serializeNodeGroup(sourceNodes),
      isShortInline: false,
      targetLang: 'zh-CN',
      colorMode: 'adaptive',
      onRetryClick: () => {},
    });

    expect(handle.mountedAsSibling).toBe(true);
    expect(h3.nextElementSibling).toBe(handle.wrapperEl);
    expect(handle.wrapperEl.getAttribute('data-bo-sibling')).toBe('true');

    updateSegmentTranslation(
      handle,
      '在全球规模下构建高韧性分布式系统',
      'done',
      'translated-only',
    );
    expect(h3.getAttribute('data-bo-stashed-host')).toBe('true');

    applyViewModeToSegment(handle, 'bilingual');
    expect(h3.hasAttribute('data-bo-stashed-host')).toBe(false);
    clearAllSiblingTypography();
  });

  it('WuPage #3: parses local .srt/.vtt subtitles, ranks candidate videos ignoring ads, and renders VTTCue in native video fullscreen', () => {
    const srtSample = `1
00:00:01,200 --> 00:00:03,800
<i>Welcome</i> to compiler design!

2
00:00:04,100 --> 00:00:06,500
Let's inspect the AST &amp; IR.`;

    const srtCues = parseLocalSubtitleFile(srtSample, 'lecture.srt');
    expect(srtCues).toHaveLength(2);
    expect(srtCues[0]).toMatchObject({
      id: 1,
      startMs: 1200,
      endMs: 3800,
      text: 'Welcome to compiler design!',
    });
    expect(srtCues[1]?.text).toBe("Let's inspect the AST & IR.");

    const vttSample = `WEBVTT

NOTE Intro block

01:02.500 --> 01:05.000 align:start position:10%
<v Speaker>Zero-copy <c.yellow>deserialization</c> rocks.</v>`;

    const vttCues = parseLocalSubtitleFile(vttSample, 'talk.vtt');
    expect(vttCues).toHaveLength(1);
    expect(vttCues[0]).toMatchObject({
      startMs: 62_500,
      endMs: 65_000,
      text: 'Zero-copy deserialization rocks.',
    });

    expect(formatSubtitleOffset(0)).toBe('0.0s');
    expect(formatSubtitleOffset(500)).toBe('+0.5s');
    expect(formatSubtitleOffset(-1000)).toBe('-1.0s');

    // Multi-video scoring: ignores ad overlay video and tiny preview video, picks main video
    document.body.innerHTML = `
      <div class="ad-showing"><video id="v-ad" width="1280" height="720"></video></div>
      <video id="v-tiny" width="120" height="68"></video>
      <div class="video-player"><video id="v-main" width="1280" height="720" controls></video></div>
    `;
    const ranked = rankCandidateVideos(document);
    expect(ranked?.id).toBe('v-main');

    // Native `<video>` fullscreen VTTCue fallback
    const mainVideo = document.getElementById('v-main') as HTMLVideoElement;
    const addedCues: Array<{ startTime: number; endTime: number; text: string }> = [];
    const mockTrack = {
      label: 'Bo Translation',
      mode: 'disabled' as TextTrackMode,
      cues: addedCues as unknown as TextTrackCueList,
      addCue: (c: unknown) => {
        addedCues.push(c as { startTime: number; endTime: number; text: string });
      },
      removeCue: (c: unknown) => {
        const idx = addedCues.indexOf(c as never);
        if (idx >= 0) addedCues.splice(idx, 1);
      },
    } as unknown as TextTrack;

    mainVideo.addTextTrack = vi.fn(() => mockTrack);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => mainVideo,
    });

    const fsRenderer = new NativeFullscreenVttRenderer();
    expect(fsRenderer.isNativeVideoFullscreen(mainVideo)).toBe(true);
    fsRenderer.syncCue(
      mainVideo,
      {
        startMs: 2000,
        endMs: 5000,
        text: 'Original line\n双语字幕译文',
      },
      'zh-CN',
    );
    expect(mockTrack.mode).toBe('showing');
    expect(addedCues).toHaveLength(1);
    expect(addedCues[0]?.text).toBe('Original line\n双语字幕译文');

    fsRenderer.deactivate(mainVideo);
    expect(mockTrack.mode).toBe('disabled');
    expect(addedCues).toHaveLength(0);

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
  });

  it('WuPage #4: detects foreign pages locally, defers hidden background tabs, and respects manual restore on same URL', async () => {
    expect(
      await detectIsForeignPage({
        sampleText:
          '这是一篇关于现代浏览器扩展架构与性能优化的深度中文技术长文，不需要触发自动翻译。',
        htmlLang: 'zh-CN',
        targetLang: 'zh-CN',
      }),
    ).toBe(false);

    expect(
      await detectIsForeignPage({
        sampleText:
          'Modern browser extensions rely on service workers and declarative net request rules for high performance.',
        htmlLang: 'en',
        targetLang: 'zh-CN',
      }),
    ).toBe(true);

    document.documentElement.lang = 'en';
    document.body.innerHTML = `
      <main>
        <p>Understanding distributed consensus algorithms requires careful reasoning about network partitions and message delays.</p>
      </main>
    `;

    // Default `localhost -> never-translate` rule blocks auto-translation even when visible
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    const blockedCtrl = new PageTranslationController({
      ...DEFAULT_SETTINGS,
      autoTranslateForeignPages: true,
      targetLang: 'zh-CN',
    });
    expect(await blockedCtrl.evaluateAutoTranslation()).toBe(false);

    // Simulate background hidden tab on a normal site (no `never-translate` rule) -> should NOT auto-translate while hidden
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    const ctrl = new PageTranslationController({
      ...DEFAULT_SETTINGS,
      siteRules: [],
      autoTranslateForeignPages: true,
      targetLang: 'zh-CN',
    });

    expect(await ctrl.evaluateAutoTranslation()).toBe(false);
    expect(ctrl.getMode()).toBe('original');

    // Tab becomes visible -> lazy auto-translation activates!
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    expect(await ctrl.evaluateAutoTranslation()).toBe(true);
    expect(ctrl.getMode()).toBe('bilingual');

    // User manually switches back to 'original' -> re-evaluating on the same URL must NOT override user choice!
    ctrl.setMode('original', { source: 'user' });
    expect(ctrl.getMode()).toBe('original');
    expect(await ctrl.evaluateAutoTranslation()).toBe(false);
    expect(ctrl.getMode()).toBe('original');

    // Navigating to a new SPA URL resets the per-URL latch so the new foreign article auto-translates!
    window.history.pushState({}, '', '/articles/next-post');
    expect(await ctrl.evaluateAutoTranslation()).toBe(true);
    expect(ctrl.getMode()).toBe('bilingual');
    ctrl.setMode('original', { source: 'auto' });
  });

  it('WuPage #5: translates prose GitHub .pl-c inline comments while skipping commented-out code & directives and preserving line alignment', () => {
    expect(parseCodeCommentText('// eslint-disable-next-line no-console')).toBeNull();
    expect(parseCodeCommentText('// const oldVal = compute(a, b);')).toBeNull();
    expect(parseCodeCommentText('// =============================')).toBeNull();

    const parsed = parseCodeCommentText('  // Verify JWT signature before caching');
    expect(parsed).toEqual({
      leadingWs: '  ',
      prefix: '//',
      body: 'Verify JWT signature before caching',
      suffix: '',
    });

    document.body.innerHTML = `
      <div class="react-code-lines">
        <div class="react-code-text"><span id="c-directive" class="pl-c">// @ts-expect-error legacy overload</span></div>
        <div class="react-code-text"><span id="c-code" class="pl-c">// return fallbackValue(ctx);</span></div>
        <div class="react-code-text"><span id="c-prose" class="pl-c">// Ensure idempotent retry token on network timeout</span></div>
      </div>
    `;

    const segs = scanTranslatableSegments(document, {
      hostname: 'github.com',
      targetLang: 'zh-CN',
      enableGithubComments: true,
    });

    expect(segs.map((s) => s.hostEl.id)).toEqual(['c-prose']);
    const seg = segs[0]!;
    expect(seg.serialized.serializedText).toBe(
      'Ensure idempotent retry token on network timeout',
    );

    const handle = mountSegmentWrapper({
      id: 99,
      hostEl: seg.hostEl,
      sourceNodes: seg.nodes,
      serialized: seg.serialized,
      isShortInline: seg.isShortInline,
      targetLang: 'zh-CN',
      codeCommentMeta: seg.codeCommentMeta,
      onRetryClick: () => {},
    });

    updateSegmentTranslation(
      handle,
      '// 在网络超时时确保幂等重试令牌',
      'done',
      'bilingual',
    );
    // Bilingual mode keeps single-line inline `// English  · 中文` (echoed `//` stripped automatically)
    expect(seg.hostEl.textContent).toBe(
      '// Ensure idempotent retry token on network timeout  · 在网络超时时确保幂等重试令牌',
    );

    // Translated-only mode preserves `// ` comment delimiter while hiding English prose
    applyViewModeToSegment(handle, 'translated-only');
    expect(seg.hostEl.textContent).toBe('// 在网络超时时确保幂等重试令牌');
  });
});
