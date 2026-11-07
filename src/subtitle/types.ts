export type VideoPlatform = 'youtube' | 'bilibili' | 'html5';

export interface SubtitleCue {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  translation?: string;
  status: 'idle' | 'pending' | 'streaming' | 'done' | 'error';
  error?: string;
}

export interface BilibiliSubtitleTrackInfo {
  id?: string | number;
  lan: string;
  lan_doc?: string;
  subtitle_url: string;
  ai_type?: number;
}

export interface BilibiliBccItem {
  from: number;
  to: number;
  content: string;
}

export const SUBTITLE_BRIDGE_SOURCE_MAIN = 'bo-trans-sub-main';
export const SUBTITLE_BRIDGE_SOURCE_ISO = 'bo-trans-sub-iso';

export type SubtitleMainBridgeMessage =
  | {
      source: typeof SUBTITLE_BRIDGE_SOURCE_MAIN;
      type: 'YT_TIMEDTEXT_MIRROR';
      url: string;
      videoId: string;
      lang: string;
      kind: string;
      body: string;
    }
  | {
      source: typeof SUBTITLE_BRIDGE_SOURCE_MAIN;
      type: 'BILI_PLAYER_META_MIRROR';
      bvid: string;
      aid: string;
      cid: string;
      subtitles: BilibiliSubtitleTrackInfo[];
    }
  | {
      source: typeof SUBTITLE_BRIDGE_SOURCE_MAIN;
      type: 'BILI_BCC_MIRROR';
      url: string;
      body: string;
    };

export type SubtitleIsoCommandMessage =
  | {
      source: typeof SUBTITLE_BRIDGE_SOURCE_ISO;
      type: 'SYNC_MIRROR_CACHE';
    }
  | {
      source: typeof SUBTITLE_BRIDGE_SOURCE_ISO;
      type: 'YT_ACTIVE_LOAD_TIMELINE';
      targetLang: string;
    }
  | {
      source: typeof SUBTITLE_BRIDGE_SOURCE_ISO;
      type: 'BILI_ACTIVE_LOAD_TIMELINE';
      preferNativeBilingual: boolean;
      targetLang: string;
    };

