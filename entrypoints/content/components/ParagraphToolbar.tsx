import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ExtensionSettings } from '../../../src/types';
import type {
  HoveredSegmentInfo,
  PageTranslationController,
} from '../dom/controller';

interface ParagraphToolbarProps {
  controller: PageTranslationController;
  settings: ExtensionSettings;
}

export const ParagraphToolbar: React.FC<ParagraphToolbarProps> = ({
  controller,
  settings,
}) => {
  const [hoverInfo, setHoverInfo] = useState<HoveredSegmentInfo | null>(null);
  const [barHovered, setBarHovered] = useState(false);

  useEffect(() => {
    return controller.subscribeHoveredSegment((info) => {
      if (info) {
        setHoverInfo(info);
      } else if (!barHovered) {
        setHoverInfo(null);
      }
    });
  }, [controller, barHovered]);

  // Update position smoothly on scroll while visible
  useEffect(() => {
    if (!hoverInfo) return;
    const onScroll = () => {
      if (!hoverInfo.handle.wrapperEl.isConnected || hoverInfo.handle.wrapperEl.hidden) {
        setHoverInfo(null);
        return;
      }
      setHoverInfo((prev) =>
        prev
          ? { ...prev, rect: prev.handle.wrapperEl.getBoundingClientRect() }
          : null,
      );
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [hoverInfo]);

  if (!hoverInfo) return null;

  const { rect, handle, peekOriginalOnly } = hoverInfo;
  if (rect.bottom < 0 || rect.top > window.innerHeight) return null;

  // Peek Original Bubble when in Translated-Only mode + holding hover modifier
  if (peekOriginalOnly) {
    const top = Math.max(10, rect.top - 8);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - 360));
    return (
      <div
        className="bo-peek-bubble"
        style={{
          left: `${ left }px`,
          top: `${ top }px`,
          transform: 'translateY(-100%)',
        }}
      >
        <div
          style={{
            fontSize: '10px',
            fontWeight: 600,
            color: 'var(--bo-accent)',
            marginBottom: '3px',
          }}
        >
          原文对照
        </div>
        <div>{handle.serialized.fullPlainText}</div>
      </div>
    );
  }

  const enabledServices = settings.services.filter((s) => s.enabled);
  const barLeft = Math.max(
    12,
    Math.min(rect.right - 148, window.innerWidth - 168),
  );
  const barTop = Math.max(8, rect.top - 28);

  return (
    <div
      className="bo-para-bar"
      style={{ left: `${ barLeft }px`, top: `${ barTop }px` }}
      onMouseEnter={() => setBarHovered(true)}
      onMouseLeave={() => {
        setBarHovered(false);
        setHoverInfo(null);
      }}
    >
      <button
        type="button"
        className="bo-ghost-btn"
        title="单段重新翻译（绕过缓存）"
        onClick={() => {
          controller.retranslateSegment(handle.id);
          setHoverInfo(null);
        }}
      >
        <RefreshCw size={11} />
        <span>重译</span>
      </button>

      {enabledServices.length > 1 && (
        <select
          className="bo-select"
          style={{ height: '22px', fontSize: '11px', width: '92px', padding: '0 4px' }}
          value=""
          onChange={(e) => {
            const svcId = e.target.value;
            if (!svcId) return;
            controller.retranslateSegment(handle.id, svcId);
            setHoverInfo(null);
          }}
        >
          <option value="" disabled>
            换服务重译
          </option>
          {enabledServices.map((svc) => (
            <option key={svc.id} value={svc.id}>
              {svc.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
};
