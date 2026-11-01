import type { ShortcutConfig } from '../types';

const MODIFIER_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
]);

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

/**
 * Serialize a KeyboardEvent into canonical `Ctrl+Alt+Shift+Meta+KeyX` form using `e.code`
 * so macOS Option-key special characters (`å`, `ß`, `∂`, `®`) never break shortcut matching.
 */
export function serializeKeyboardEvent(e: KeyboardEvent): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;

  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');

  // Require at least one modifier key (unless F1-F12) to avoid hijacking normal typing
  if (mods.length === 0 && !/^F([1-9]|1[0-2])$/.test(e.code)) {
    return null;
  }

  return [...mods, e.code].join('+');
}

export function matchesShortcut(e: KeyboardEvent, binding: string): boolean {
  if (!binding || !binding.trim()) return false;
  const parts = binding.split('+').map((p) => p.trim());
  const expectedCode = parts[parts.length - 1];
  const modSet = new Set(parts.slice(0, -1));

  if (e.code !== expectedCode) return false;
  if (Boolean(e.ctrlKey) !== modSet.has('Ctrl')) return false;
  if (Boolean(e.altKey) !== modSet.has('Alt')) return false;
  if (Boolean(e.shiftKey) !== modSet.has('Shift')) return false;
  if (Boolean(e.metaKey) !== modSet.has('Meta')) return false;

  return true;
}

export function formatShortcutLabel(
  binding: string,
  mac = isMacPlatform(),
): string {
  if (!binding || !binding.trim()) return '未设置';

  const parts = binding.split('+').map((p) => p.trim());
  return parts
    .map((part) => {
      if (part === 'Ctrl') return mac ? '⌃' : 'Ctrl';
      if (part === 'Alt') return mac ? '⌥' : 'Alt';
      if (part === 'Shift') return mac ? '⇧' : 'Shift';
      if (part === 'Meta') return mac ? '⌘' : 'Win';
      if (part.startsWith('Key')) return part.slice(3).toUpperCase();
      if (part.startsWith('Digit')) return part.slice(5);
      if (part === 'Space') return 'Space';
      return part;
    })
    .join(mac ? ' ' : ' + ');
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.closest('[contenteditable="true"], .monaco-editor, .cm-editor')) {
    return true;
  }
  return false;
}

export function detectShortcutConflicts(
  shortcuts: ShortcutConfig,
): Partial<Record<keyof ShortcutConfig, string>> {
  const entries: Array<[keyof ShortcutConfig, string, string]> = [
    ['toggleBilingual', shortcuts.toggleBilingual, '切换双语对照'],
    ['toggleTranslatedOnly', shortcuts.toggleTranslatedOnly, '切换仅看译文'],
    ['selectionLookup', shortcuts.selectionLookup, '选中文字释义'],
    ['retranslateParagraph', shortcuts.retranslateParagraph, '单段重译'],
  ];

  const conflicts: Partial<Record<keyof ShortcutConfig, string>> = {};
  for (let i = 0; i < entries.length; i++) {
    const entryA = entries[i];
    if (!entryA) continue;
    const [keyA, bindA, labelA] = entryA;
    if (!bindA) continue;
    for (let j = i + 1; j < entries.length; j++) {
      const entryB = entries[j];
      if (!entryB) continue;
      const [keyB, bindB, labelB] = entryB;
      if (bindA === bindB) {
        conflicts[keyA] = `与「${ labelB }」快捷键冲突`;
        conflicts[keyB] = `与「${ labelA }」快捷键冲突`;
      }
    }
  }
  return conflicts;
}
