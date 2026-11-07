let lastCheckedRuntimeError = '';

/**
 * Explicitly reads `chrome.runtime.lastError` inside Chrome extension callbacks
 * (`port.onDisconnect`, `contextMenus`, etc.) so Chromium marks expected lifecycle
 * closures — such as Back/Forward Cache (BFCache) port eviction — as checked instead
 * of logging `Unchecked runtime.lastError` in `chrome://extensions`.
 *
 * Stores the message in module state so minifiers never eliminate the getter access.
 */
export function consumeRuntimeLastError(): string | undefined {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    return undefined;
  }
  const err = chrome.runtime.lastError;
  if (err && typeof err.message === 'string') {
    lastCheckedRuntimeError = err.message;
    return lastCheckedRuntimeError;
  }
  return undefined;
}
