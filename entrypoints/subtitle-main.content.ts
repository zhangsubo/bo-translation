import {
  SUBTITLE_BRIDGE_SOURCE_ISO,
  SUBTITLE_BRIDGE_SOURCE_MAIN,
  type BilibiliSubtitleTrackInfo,
  type SubtitleIsoCommandMessage,
  type SubtitleMainBridgeMessage,
} from '../src/subtitle/types';

// Compact RFC1321 MD5 implementation (used ONLY when user explicitly unlocks active Bilibili WBI fetch)
function md5Hex(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const bitLen = utf8.length * 8;
  const padLen = ((56 - ((utf8.length + 1) % 64)) + 64) % 64;
  const buf = new Uint8Array(utf8.length + 1 + padLen + 8);
  buf.set(utf8);
  buf[utf8.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(buf.length - 8, bitLen >>> 0, true);
  view.setUint32(buf.length - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }

  for (let offset = 0; offset < buf.length; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const word = view.getUint32(offset + g * 4, true);
      const shift = s[i]!;
      const temp = d;
      d = c;
      c = b;
      const sum = (a + f + k[i]! + word) >>> 0;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
      a = temp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const WBI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

let cachedWbiMixinKey = '';

async function getBiliMixinKey(origFetch: typeof window.fetch): Promise<string> {
  if (cachedWbiMixinKey) return cachedWbiMixinKey;
  const res = await origFetch('https://api.bilibili.com/x/web-interface/nav', {
    credentials: 'include',
  });
  const json = await res.json();
  const imgUrl: string = json?.data?.wbi_img?.img_url ?? '';
  const subUrl: string = json?.data?.wbi_img?.sub_url ?? '';
  const imgKey = imgUrl.split('/').pop()?.split('.')[0] ?? '';
  const subKey = subUrl.split('/').pop()?.split('.')[0] ?? '';
  const raw = imgKey + subKey;
  if (raw.length < 64) return '';
  cachedWbiMixinKey = WBI_MIXIN_TAB.map((idx) => raw[idx] ?? '')
    .join('')
    .slice(0, 32);
  return cachedWbiMixinKey;
}

function postToIsolated(msg: SubtitleMainBridgeMessage): void {
  window.postMessage(msg, '*');
}

function normalizeHttpsUrl(rawUrl: string): string {
  if (rawUrl.startsWith('//')) return `https:${ rawUrl }`;
  if (rawUrl.startsWith('http://')) return `https://${ rawUrl.slice(7) }`;
  return rawUrl;
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*', '*://*.bilibili.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const origFetch = window.fetch.bind(window);
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;

    let lastYtSignedUrl = '';
    let lastYtVideoId = '';
    let lastYtMirror: Extract<
      SubtitleMainBridgeMessage,
      { type: 'YT_TIMEDTEXT_MIRROR' }
    > | null = null;
    let lastBiliMeta: Extract<
      SubtitleMainBridgeMessage,
      { type: 'BILI_PLAYER_META_MIRROR' }
    > | null = null;
    const recentBiliBccMirrors = new Map<string, string>();

    const inspectMirroredPayload = (rawUrl: string, bodyText: string) => {
      if (!rawUrl || !bodyText) return;

      // 1. YouTube timedtext passive mirror (0 extra requests)
      if (rawUrl.includes('/api/timedtext')) {
        try {
          const parsedUrl = new URL(rawUrl, window.location.origin);
          const videoId = parsedUrl.searchParams.get('v') ?? '';
          const lang =
            parsedUrl.searchParams.get('tlang') ||
            parsedUrl.searchParams.get('lang') ||
            '';
          const kind = parsedUrl.searchParams.get('kind') ?? '';
          if (videoId) {
            lastYtSignedUrl = parsedUrl.toString();
            lastYtVideoId = videoId;
            lastYtMirror = {
              source: SUBTITLE_BRIDGE_SOURCE_MAIN,
              type: 'YT_TIMEDTEXT_MIRROR',
              url: parsedUrl.toString(),
              videoId,
              lang,
              kind,
              body: bodyText,
            };
            postToIsolated(lastYtMirror);
          }
        } catch {
          // ignore malformed URL
        }
        return;
      }

      // 2. Bilibili player metadata passive mirror (0 extra requests)
      if (
        rawUrl.includes('/x/player/wbi/v2') ||
        rawUrl.includes('/x/player/v2')
      ) {
        try {
          const parsedUrl = new URL(rawUrl, window.location.origin);
          const json = JSON.parse(bodyText);
          const subs: BilibiliSubtitleTrackInfo[] = Array.isArray(
            json?.data?.subtitle?.subtitles,
          )
            ? json.data.subtitle.subtitles
            : [];
          const aid = String(
            json?.data?.aid || parsedUrl.searchParams.get('aid') || '',
          );
          const bvid = String(
            json?.data?.bvid || parsedUrl.searchParams.get('bvid') || '',
          );
          const cid = String(
            json?.data?.cid || parsedUrl.searchParams.get('cid') || '',
          );
          lastBiliMeta = {
            source: SUBTITLE_BRIDGE_SOURCE_MAIN,
            type: 'BILI_PLAYER_META_MIRROR',
            bvid,
            aid,
            cid,
            subtitles: subs,
          };
          postToIsolated(lastBiliMeta);
        } catch {
          // ignore
        }
        return;
      }

      // 3. Bilibili BCC subtitle JSON passive mirror (0 extra requests)
      if (
        rawUrl.includes('hdslb.com/bfs/subtitle/') ||
        rawUrl.includes('hdslb.com/bfs/ai_subtitle/')
      ) {
        if (recentBiliBccMirrors.size >= 6) {
          const oldest = recentBiliBccMirrors.keys().next().value;
          if (oldest !== undefined) recentBiliBccMirrors.delete(oldest);
        }
        recentBiliBccMirrors.set(rawUrl, bodyText);
        postToIsolated({
          source: SUBTITLE_BRIDGE_SOURCE_MAIN,
          type: 'BILI_BCC_MIRROR',
          url: rawUrl,
          body: bodyText,
        });
      }
    };

    // Read-only pass-through fetch wrapper
    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const response = await origFetch(...args);
      try {
        const reqInput = args[0];
        const reqUrl =
          typeof reqInput === 'string'
            ? reqInput
            : reqInput instanceof URL
              ? reqInput.toString()
              : reqInput?.url ?? '';

        if (
          reqUrl.includes('/api/timedtext') ||
          reqUrl.includes('/x/player/') ||
          reqUrl.includes('hdslb.com/bfs/')
        ) {
          response
            .clone()
            .text()
            .then((text) => inspectMirroredPayload(reqUrl, text))
            .catch(() => {});
        }
      } catch {
        // never break host page fetch
      }
      return response;
    };

    // Read-only pass-through XHR wrapper
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      (this as XMLHttpRequest & { __boUrl?: string }).__boUrl = String(url);
      return (origXhrOpen as (...a: unknown[]) => void).apply(this, [
        method,
        url,
        ...rest,
      ]);
    };

    XMLHttpRequest.prototype.send = function (
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const boUrl = (this as XMLHttpRequest & { __boUrl?: string }).__boUrl ?? '';
      if (
        boUrl.includes('/api/timedtext') ||
        boUrl.includes('/x/player/') ||
        boUrl.includes('hdslb.com/bfs/')
      ) {
        this.addEventListener('load', () => {
          try {
            if (typeof this.responseText === 'string' && this.responseText) {
              inspectMirroredPayload(boUrl, this.responseText);
            }
          } catch {
            // responseType may be arraybuffer/blob in unrelated endpoints
          }
        });
      }
      return origXhrSend.call(this, body);
    };

    // Active timeline loader — STRICTLY invoked only when ISOLATED script sends command
    // after verifying the user unlocked (20 taps) AND enabled active timeline fetch.
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      const msg = event.data as SubtitleIsoCommandMessage | undefined;
      if (!msg || msg.source !== SUBTITLE_BRIDGE_SOURCE_ISO) return;

      if (msg.type === 'SYNC_MIRROR_CACHE') {
        if (lastYtMirror) {
          postToIsolated(lastYtMirror);
        }
        if (lastBiliMeta) {
          postToIsolated(lastBiliMeta);
        }
        for (const [url, body] of recentBiliBccMirrors.entries()) {
          postToIsolated({
            source: SUBTITLE_BRIDGE_SOURCE_MAIN,
            type: 'BILI_BCC_MIRROR',
            url,
            body,
          });
        }
        return;
      }

      if (msg.type === 'YT_ACTIVE_LOAD_TIMELINE') {
        try {
          const currentVid = new URL(window.location.href).searchParams.get('v') ?? '';
          if (!currentVid) return;

          // If we already observed a signed timedtext URL for this video, request json3 format cleanly
          if (lastYtSignedUrl && lastYtVideoId === currentVid) {
            const u = new URL(lastYtSignedUrl);
            u.searchParams.set('fmt', 'json3');
            const res = await origFetch(u.toString(), { credentials: 'include' });
            if (res.ok) {
              const text = await res.text();
              inspectMirroredPayload(u.toString(), text);
              return;
            }
          }

          // Otherwise ask YouTube's movie_player to activate captions so it fires its signed request
          const playerEl = document.getElementById('movie_player') as
            | (HTMLElement & {
                loadModule?: (mod: string) => void;
                getPlayerResponse?: () => unknown;
              })
            | null;
          playerEl?.loadModule?.('captions');

          const subBtn = document.querySelector<HTMLButtonElement>(
            '.ytp-subtitles-button',
          );
          if (subBtn && subBtn.getAttribute('aria-pressed') === 'false') {
            subBtn.click();
          }
        } catch {
          // ignore
        }
      }

      if (msg.type === 'BILI_ACTIVE_LOAD_TIMELINE') {
        try {
          const win = window as Window & {
            __INITIAL_STATE__?: {
              aid?: number | string;
              bvid?: string;
              cid?: number | string;
              p?: number;
              videoData?: {
                aid?: number | string;
                bvid?: string;
                cid?: number | string;
                pages?: Array<{ page?: number; cid?: number | string }>;
              };
              epInfo?: {
                aid?: number | string;
                bvid?: string;
                cid?: number | string;
              };
            };
          };

          const st = win.__INITIAL_STATE__;
          const pParam = Number(
            new URL(window.location.href).searchParams.get('p') || st?.p || 1,
          );
          const pageEntry = st?.videoData?.pages?.find((pg) => pg.page === pParam);

          const aid = String(
            st?.videoData?.aid || st?.epInfo?.aid || st?.aid || lastBiliMeta?.aid || '',
          );
          const bvid = String(
            st?.videoData?.bvid || st?.epInfo?.bvid || st?.bvid || lastBiliMeta?.bvid || '',
          );
          const cid = String(
            pageEntry?.cid ||
              st?.videoData?.cid ||
              st?.epInfo?.cid ||
              st?.cid ||
              lastBiliMeta?.cid ||
              '',
          );

          let subtitles =
            lastBiliMeta && lastBiliMeta.cid === cid ? lastBiliMeta.subtitles : [];

          if (subtitles.length === 0 && cid && (aid || bvid)) {
            const mixinKey = await getBiliMixinKey(origFetch);
            const params = new URLSearchParams();
            if (aid) params.set('aid', aid);
            if (bvid) params.set('bvid', bvid);
            params.set('cid', cid);
            if (mixinKey) {
              const wts = String(Math.floor(Date.now() / 1000));
              params.set('wts', wts);
              params.sort();
              const wRid = md5Hex(params.toString() + mixinKey);
              params.set('w_rid', wRid);
            }

            const metaUrl = `https://api.bilibili.com/x/player/wbi/v2?${ params.toString() }`;
            const res = await origFetch(metaUrl, { credentials: 'include' });
            if (res.ok) {
              const text = await res.text();
              inspectMirroredPayload(metaUrl, text);
              const parsed = JSON.parse(text);
              subtitles = Array.isArray(parsed?.data?.subtitle?.subtitles)
                ? parsed.data.subtitle.subtitles
                : [];
            }
          }

          // Fetch BCC subtitle JSON files for available tracks
          for (const track of subtitles) {
            if (!track.subtitle_url) continue;
            const fullUrl = normalizeHttpsUrl(track.subtitle_url);
            const bccRes = await origFetch(fullUrl);
            if (bccRes.ok) {
              const bccText = await bccRes.text();
              inspectMirroredPayload(fullUrl, bccText);
            }
          }
        } catch {
          // ignore
        }
      }
    });
  },
});
