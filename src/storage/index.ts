import type {
  ExtensionSettings,
  GlossaryEntry,
  ServiceProfile,
  SiteRule,
} from '../types';
import { DEFAULT_SETTINGS } from './defaults';

export const SETTINGS_STORAGE_KEY = 'bo_translation_settings_v1';

let memoryStore: ExtensionSettings = structuredClone(DEFAULT_SETTINGS);
const memoryListeners = new Set<(settings: ExtensionSettings) => void>();

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    Boolean(chrome.storage) &&
    Boolean(chrome.storage.local)
  );
}

const REMOVED_LEGACY_PRESETS = new Set([
  'deepseek',
  'siliconflow',
  'openrouter',
]);

export function normalizeSettings(
  raw?: Partial<ExtensionSettings> | null,
): ExtensionSettings {
  if (!raw || typeof raw !== 'object') {
    return structuredClone(DEFAULT_SETTINGS);
  }

  const migratedServices = Array.isArray(raw.services)
    ? raw.services
        .filter((s) => {
          const presetStr = String(s.preset ?? '');
          // Drop untouched legacy default cards that had no API key configured
          if (REMOVED_LEGACY_PRESETS.has(presetStr) && !s.apiKey?.trim()) {
            return false;
          }
          return true;
        })
        .map((s) => {
          const presetStr = String(s.preset ?? '');
          if (REMOVED_LEGACY_PRESETS.has(presetStr)) {
            return { ...s, preset: 'custom' as const };
          }
          return s;
        })
    : [];

  const services =
    migratedServices.length > 0
      ? migratedServices
      : structuredClone(DEFAULT_SETTINGS.services);

  const primaryExists = services.some((s) => s.id === raw.primaryServiceId && s.enabled);
  const fallbackPrimary =
    services.find((s) => s.enabled)?.id ?? services[0]!.id;

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    primaryServiceId: primaryExists
      ? (raw.primaryServiceId as string)
      : fallbackPrimary,
    selectionServiceId: raw.selectionServiceId ?? DEFAULT_SETTINGS.selectionServiceId,
    comparisonServiceIds: Array.isArray(raw.comparisonServiceIds)
      ? raw.comparisonServiceIds
      : DEFAULT_SETTINGS.comparisonServiceIds,
    shortcuts: {
      ...DEFAULT_SETTINGS.shortcuts,
      ...(raw.shortcuts ?? {}),
    },
    floatingTab: {
      ...DEFAULT_SETTINGS.floatingTab,
      ...(raw.floatingTab ?? {}),
    },
    services,
    glossary: Array.isArray(raw.glossary)
      ? raw.glossary
      : structuredClone(DEFAULT_SETTINGS.glossary),
    siteRules: Array.isArray(raw.siteRules)
      ? raw.siteRules
      : structuredClone(DEFAULT_SETTINGS.siteRules),
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  if (!hasChromeStorage()) {
    return structuredClone(memoryStore);
  }
  const data = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const raw = data?.[SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  if (!raw) {
    const initial = structuredClone(DEFAULT_SETTINGS);
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: initial });
    return initial;
  }
  return normalizeSettings(raw);
}

export async function saveSettings(
  next: ExtensionSettings,
): Promise<ExtensionSettings> {
  const normalized = normalizeSettings(next);
  if (!hasChromeStorage()) {
    memoryStore = structuredClone(normalized);
    for (const listener of memoryListeners) {
      listener(structuredClone(memoryStore));
    }
    return normalized;
  }
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized });
  return normalized;
}

export async function updateSettings(
  patchOrUpdater:
    | Partial<ExtensionSettings>
    | ((prev: ExtensionSettings) => ExtensionSettings),
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const updated =
    typeof patchOrUpdater === 'function'
      ? patchOrUpdater(current)
      : { ...current, ...patchOrUpdater };
  return saveSettings(updated);
}

export async function upsertGlossaryEntry(
  entry: Omit<GlossaryEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): Promise<GlossaryEntry> {
  const trimmedSource = entry.source.trim();
  let savedEntry!: GlossaryEntry;

  await updateSettings((prev) => {
    const existingIdx = prev.glossary.findIndex(
      (item) =>
        (entry.id && item.id === entry.id) ||
        item.source.toLowerCase() === trimmedSource.toLowerCase(),
    );

    if (existingIdx >= 0) {
      const existingItem = prev.glossary[existingIdx]!;
      savedEntry = {
        ...existingItem,
        ...entry,
        id: existingItem.id,
        createdAt: existingItem.createdAt,
        source: trimmedSource,
        target: entry.strategy === 'keep' ? '' : entry.target.trim(),
      };
      const nextGlossary = [...prev.glossary];
      nextGlossary[existingIdx] = savedEntry;
      return { ...prev, glossary: nextGlossary };
    }

    savedEntry = {
      id: entry.id ?? `gls_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 6) }`,
      source: trimmedSource,
      target: entry.strategy === 'keep' ? '' : entry.target.trim(),
      strategy: entry.strategy,
      caseSensitive: entry.caseSensitive,
      note: entry.note?.trim() ?? '',
      enabled: entry.enabled ?? true,
      createdAt: entry.createdAt ?? Date.now(),
    };
    return {
      ...prev,
      glossary: [savedEntry, ...prev.glossary],
    };
  });

  return savedEntry;
}

export function resolvePrimaryService(settings: ExtensionSettings): ServiceProfile {
  return (
    settings.services.find((s) => s.id === settings.primaryServiceId && s.enabled) ??
    settings.services.find((s) => s.enabled) ??
    settings.services[0] ??
    DEFAULT_SETTINGS.services[0]!
  );
}

export function resolveSelectionService(settings: ExtensionSettings): ServiceProfile {
  if (settings.selectionServiceId && settings.selectionServiceId !== 'follow-primary') {
    const custom = settings.services.find(
      (s) => s.id === settings.selectionServiceId && s.enabled,
    );
    if (custom) return custom;
  }
  return resolvePrimaryService(settings);
}

export function matchHostnamePattern(hostname: string, pattern: string): boolean {
  const cleanHost = hostname.trim().toLowerCase();
  const cleanPattern = pattern.trim().toLowerCase();
  if (!cleanHost || !cleanPattern) return false;

  if (cleanPattern === '*') return true;
  if (cleanPattern.startsWith('*.')) {
    const suffix = cleanPattern.slice(2);
    return cleanHost === suffix || cleanHost.endsWith(`.${ suffix }`);
  }
  return cleanHost === cleanPattern;
}

export function matchSiteRule(
  hostname: string,
  rules: SiteRule[],
): SiteRule | undefined {
  const enabledRules = rules.filter((r) => r.enabled);
  // Exact match takes precedence over wildcard match
  const exact = enabledRules.find(
    (r) => !r.pattern.includes('*') && matchHostnamePattern(hostname, r.pattern),
  );
  if (exact) return exact;
  return enabledRules.find((r) => matchHostnamePattern(hostname, r.pattern));
}

export function subscribeSettings(
  listener: (settings: ExtensionSettings) => void,
): () => void {
  if (!hasChromeStorage()) {
    memoryListeners.add(listener);
    return () => {
      memoryListeners.delete(listener);
    };
  }

  const handler = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string,
  ) => {
    if (areaName === 'local' && changes[SETTINGS_STORAGE_KEY]?.newValue) {
      listener(
        normalizeSettings(
          changes[SETTINGS_STORAGE_KEY].newValue as Partial<ExtensionSettings>,
        ),
      );
    }
  };

  chrome.storage.onChanged.addListener(handler);
  return () => {
    chrome.storage.onChanged.removeListener(handler);
  };
}

export * from './defaults';
