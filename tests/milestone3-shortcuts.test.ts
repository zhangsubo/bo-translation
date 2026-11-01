import { describe, expect, it } from 'vitest';
import {
  detectShortcutConflicts,
  formatShortcutLabel,
  matchesShortcut,
  serializeKeyboardEvent,
} from '../src/shortcuts';
import { DEFAULT_SETTINGS } from '../src/storage';

describe('Milestone 3: Custom Keyboard Shortcut Engine', () => {
  it('matches Alt+KeyA reliably even when macOS Option+A produces e.key === "å"', () => {
    const macOptionAEvent = new KeyboardEvent('keydown', {
      key: 'å',
      code: 'KeyA',
      altKey: true,
    });

    expect(serializeKeyboardEvent(macOptionAEvent)).toBe('Alt+KeyA');
    expect(matchesShortcut(macOptionAEvent, 'Alt+KeyA')).toBe(true);
    expect(matchesShortcut(macOptionAEvent, 'Ctrl+KeyA')).toBe(false);
  });

  it('formats Mac and Windows/Linux shortcut labels cleanly', () => {
    expect(formatShortcutLabel('Alt+KeyD', true)).toBe('⌥ D');
    expect(formatShortcutLabel('Ctrl+Shift+KeyR', false)).toBe('Ctrl + Shift + R');
  });

  it('detects duplicate shortcut bindings across actions', () => {
    const noConflict = detectShortcutConflicts(DEFAULT_SETTINGS.shortcuts);
    expect(Object.keys(noConflict)).toHaveLength(0);

    const withConflict = detectShortcutConflicts({
      ...DEFAULT_SETTINGS.shortcuts,
      selectionLookup: 'Alt+KeyA',
    });
    expect(withConflict.toggleBilingual).toContain('选中文字释义');
    expect(withConflict.selectionLookup).toContain('切换双语对照');
  });
});
