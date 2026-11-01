import { describe, expect, it } from 'vitest';
import {
  applyViewModeToSegment,
  mountSegmentWrapper,
  updateSegmentTranslation,
} from '../entrypoints/content/dom/renderer';
import { shouldSkipTextSegment } from '../entrypoints/content/dom/rules';
import { scanTranslatableSegments } from '../entrypoints/content/dom/scanner';
import {
  restoreRichTranslation,
  serializeNodeGroup,
} from '../entrypoints/content/dom/serializer';

describe('Milestone 2: DOM Discovery, Rich-Text Protection & Three-State Renderer', () => {
  it('skips <pre>, code editors, pure-code paragraphs, semver, API paths, and predominantly Chinese text', () => {
    document.body.innerHTML = `
      <main>
        <p id="p-prose">Understanding React concurrent rendering in modern web apps.</p>
        <pre><code>function hello() { return 42; }</code></pre>
        <div class="monaco-editor"><p>Editor line content should be ignored</p></div>
        <p id="p-pure-code"><code>npm install wxt</code></p>
        <table>
          <tr>
            <td>MAX_CONCURRENCY</td>
            <td>/v1/chat/completions</td>
            <td id="td-desc">Maximum parallel translation requests per service.</td>
          </tr>
        </table>
        <p id="p-zh">这是一段已经翻译好的简体中文技术说明文字，不需要重复发送请求。</p>
      </main>
    `;

    const segments = scanTranslatableSegments(document, {
      hostname: 'docs.example.com',
      targetLang: 'zh-CN',
    });

    expect(segments.map((s) => s.hostEl.id)).toEqual(['p-prose', 'td-desc']);
    expect(shouldSkipTextSegment('v1.12.0-beta.2', 'P', 'zh-CN')).toBe(true);
    expect(shouldSkipTextSegment('./src/providers/openai.ts', 'P', 'zh-CN')).toBe(true);
  });

  it('splits nested <li> mixed inline-and-block structures without clobbering child lists', () => {
    document.body.innerHTML = `
      <ul>
        <li id="outer-li">
          Configure the local server before starting:
          <ul>
            <li id="inner-li-1">Install model weights locally</li>
            <li id="inner-li-2">Verify port connectivity</li>
          </ul>
        </li>
      </ul>
    `;

    const segments = scanTranslatableSegments(document, {
      hostname: 'docs.example.com',
      targetLang: 'zh-CN',
    });

    expect(segments).toHaveLength(3);
    expect(segments[0]?.hostEl.id).toBe('outer-li');
    expect(segments[0]?.serialized.translatablePlainText).toBe(
      'Configure the local server before starting:',
    );
    expect(segments[1]?.hostEl.id).toBe('inner-li-1');
    expect(segments[2]?.hostEl.id).toBe('inner-li-2');
  });

  it('locks a:has(code) and inline <code> opaquely while restoring nested <a href> and <strong> tags safely', () => {
    document.body.innerHTML = `
      <p id="rich-p">
        Call <a href="/reference/use-effect" class="api-link"><code>useEffect()</code></a> inside
        <a href="https://react.dev/learn" target="_blank" class="doc-link">the <strong>official guide</strong></a>
        when <code>count</code> changes.
      </p>
    `;

    const p = document.getElementById('rich-p')!;
    const serialized = serializeNodeGroup(Array.from(p.childNodes));

    // `a:has(code)` and `code` become {{0}} and {{1}}; `<a href>` and `<strong>` become `<a0>` and `<a1>`
    expect(serialized.serializedText).toBe(
      'Call {{0}} inside <a0>the <a1>official guide</a1></a0> when {{1}} changes.',
    );

    // Simulate LLM translation containing math `x < 10` + preserved `<a0><a1>` + `{{0}}` / `{{1}}`
    const restoredHtml = restoreRichTranslation(
      '当 {{1}} 变化且 x < 10 时，在<a0><a1>官方指南</a1></a0>中调用 {{0}}。',
      serialized,
    );

    const container = document.createElement('div');
    container.innerHTML = restoredHtml;

    const apiLink = container.querySelector('a.api-link');
    expect(apiLink?.getAttribute('href')).toBe('/reference/use-effect');
    expect(apiLink?.querySelector('code')?.textContent).toBe('useEffect()');

    const docLink = container.querySelector('a.doc-link');
    expect(docLink?.getAttribute('href')).toBe('https://react.dev/learn');
    expect(docLink?.querySelector('strong')?.textContent).toBe('官方指南');

    expect(container.textContent).toContain('x < 10');
  });

  it('switches losslessly across bilingual, translated-only, and original modes in <li> and <td>', () => {
    document.body.innerHTML = `<ul><li id="item">Read <code>README.md</code> carefully.</li></ul>`;
    const li = document.getElementById('item')!;
    const sourceNodes = Array.from(li.childNodes);
    const serialized = serializeNodeGroup(sourceNodes);

    const handle = mountSegmentWrapper({
      id: 1,
      hostEl: li,
      sourceNodes,
      serialized,
      isShortInline: false,
      targetLang: 'zh-CN',
      onRetryClick: () => {},
    });

    updateSegmentTranslation(handle, '请仔细阅读 {{0}}。', 'done', 'bilingual', {
      serviceId: 'svc_1',
      serviceName: 'OpenAI',
    });

    // Bilingual: both English and Chinese visible inside <li>
    expect(li.textContent).toContain('Read README.md carefully.');
    expect(li.textContent).toContain('请仔细阅读 README.md。');

    // Translated-Only: original nodes stashed into <template>, only Chinese visible, <li> remains intact
    applyViewModeToSegment(handle, 'translated-only');
    expect(li.textContent?.trim()).toBe('请仔细阅读 README.md。');
    expect(handle.backupTemplate.content.childNodes.length).toBeGreaterThan(0);

    // Original: exact original nodes restored before <bo-trans>, <bo-trans> hidden
    applyViewModeToSegment(handle, 'original');
    expect(handle.wrapperEl.hidden).toBe(true);
    expect(li.querySelector('code')?.textContent).toBe('README.md');
    expect(handle.isOriginalStashed).toBe(false);

    // Back to Bilingual: instant zero-network reveal
    applyViewModeToSegment(handle, 'bilingual');
    expect(handle.wrapperEl.hidden).toBe(false);
    expect(li.textContent).toContain('Read README.md carefully.');
    expect(li.textContent).toContain('请仔细阅读 README.md。');
  });
});
