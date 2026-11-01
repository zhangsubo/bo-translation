import { useCallback, useEffect, useState } from 'react';
import type { ExtensionSettings } from '../types';
import {
  DEFAULT_SETTINGS,
  getSettings,
  subscribeSettings,
  updateSettings,
} from './index';

export function useSettings() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    getSettings().then((loaded) => {
      if (mounted) {
        setSettings(loaded);
        setLoading(false);
      }
    });

    const unsubscribe = subscribeSettings((next) => {
      if (mounted) {
        setSettings(next);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const patchSettings = useCallback(
    async (
      patchOrUpdater:
        | Partial<ExtensionSettings>
        | ((prev: ExtensionSettings) => ExtensionSettings),
    ) => {
      const next = await updateSettings(patchOrUpdater);
      setSettings(next);
      return next;
    },
    [],
  );

  return { settings, loading, patchSettings };
}
