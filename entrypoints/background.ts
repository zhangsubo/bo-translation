import { ConcurrencyLimiter } from '../src/providers/concurrency';
import {
  executeBatchTranslation,
  executeSelectionLookup,
  fetchAvailableModels,
  normalizeOpenAIEndpoints,
  testServiceConnectivity,
} from '../src/providers/openai';
import {
  getSettings,
  resolvePrimaryService,
  resolveSelectionService,
  subscribeSettings,
} from '../src/storage';
import type {
  ExtensionSettings,
  RuntimeRequestMessage,
  ServiceProfile,
  StreamPortClientMessage,
  StreamPortServerMessage,
} from '../src/types';

export const STREAM_PORT_NAME = 'bo-trans-stream';

const serviceLimiters = new Map<string, ConcurrencyLimiter>();

function getServiceLimiter(service: ServiceProfile): ConcurrencyLimiter {
  const limit = Math.max(1, Math.min(16, service.maxConcurrency || 4));
  let limiter = serviceLimiters.get(service.id);
  if (!limiter) {
    limiter = new ConcurrencyLimiter(limit);
    serviceLimiters.set(service.id, limiter);
  } else {
    limiter.setLimit(limit);
  }
  return limiter;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.includes('Aborted'))
  );
}

async function syncLocalOriginDnrRules(
  extraUrls: string[] = [],
): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;

  try {
    const settings = await getSettings();
    const candidateUrls = [
      'http://127.0.0.1:11434/v1',
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://localhost:1234/v1',
      ...settings.services.map((s) => s.baseUrl),
      ...extraUrls,
    ];

    const localOrigins = new Set<string>();
    for (const rawUrl of candidateUrls) {
      try {
        const ep = normalizeOpenAIEndpoints(rawUrl);
        if (ep.isLocal) {
          localOrigins.add(ep.origin);
        }
      } catch {
        // ignore invalid url during typing
      }
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);

    const localOriginRules: chrome.declarativeNetRequest.Rule[] = Array.from(
      localOrigins,
    ).map((origin, idx) => ({
      id: 4000 + idx,
      priority: 1,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          {
            header: 'Origin',
            operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value: origin,
          },
        ],
      },
      condition: {
        urlFilter: `${ origin }/*`,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [
          'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
          'other' as chrome.declarativeNetRequest.ResourceType,
        ],
      },
    }));

    // Kimi Code (/coding/v1) enforces a coding-agent User-Agent check
    const kimiCodeRules: chrome.declarativeNetRequest.Rule[] = [
      'https://api.kimi.com/coding/*',
      'https://api.kimi.ai/coding/*',
    ].map((urlFilter, idx) => ({
      id: 4500 + idx,
      priority: 1,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          {
            header: 'User-Agent',
            operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value: 'claude-code/2.0.0',
          },
        ],
      },
      condition: {
        urlFilter,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [
          'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
          'other' as chrome.declarativeNetRequest.ResourceType,
        ],
      },
    }));

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: [...localOriginRules, ...kimiCodeRules],
    });
  } catch (err) {
    console.warn('[Bo Translation] DNR rule sync warning:', err);
  }
}

function resolveServiceById(
  settings: ExtensionSettings,
  serviceId: string | undefined,
  mode: 'batch' | 'lookup',
): ServiceProfile {
  if (serviceId) {
    const found = settings.services.find((s) => s.id === serviceId);
    if (found) return found;
  }
  return mode === 'lookup'
    ? resolveSelectionService(settings)
    : resolvePrimaryService(settings);
}

export default defineBackground(() => {
  syncLocalOriginDnrRules();

  subscribeSettings(() => {
    syncLocalOriginDnrRules();
  });

  if (chrome.contextMenus) {
    chrome.runtime.onInstalled.addListener(() => {
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
          id: 'bo-toggle-bilingual',
          title: '切换双语对照翻译 (Bo Translation)',
          contexts: ['page', 'selection'],
        });
      });
    });

    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === 'bo-toggle-bilingual' && tab?.id) {
        chrome.tabs
          .sendMessage(tab.id, { type: 'TOGGLE_PAGE_BILINGUAL' })
          .catch(() => {});
      }
    });
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== STREAM_PORT_NAME) return;

    const inFlightControllers = new Map<string, AbortController>();
    let portClosed = false;

    const safePost = (msg: StreamPortServerMessage) => {
      if (portClosed) return;
      try {
        port.postMessage(msg);
      } catch {
        portClosed = true;
      }
    };

    port.onDisconnect.addListener(() => {
      portClosed = true;
      for (const ctrl of inFlightControllers.values()) {
        ctrl.abort();
      }
      inFlightControllers.clear();
    });

    port.onMessage.addListener(async (rawMsg: StreamPortClientMessage) => {
      if (!rawMsg || typeof rawMsg !== 'object') return;

      if (rawMsg.type === 'CANCEL_REQUEST') {
        const ctrl = inFlightControllers.get(rawMsg.requestId);
        if (ctrl) {
          ctrl.abort();
          inFlightControllers.delete(rawMsg.requestId);
        }
        return;
      }

      if (rawMsg.type === 'TRANSLATE_BATCH') {
        const controller = new AbortController();
        inFlightControllers.set(rawMsg.requestId, controller);

        try {
          const settings = await getSettings();
          const service = resolveServiceById(settings, rawMsg.serviceId, 'batch');
          const limiter = getServiceLimiter(service);
          const sourceLang = rawMsg.sourceLang ?? settings.sourceLang;
          const targetLang = rawMsg.targetLang ?? settings.targetLang;

          const { completedIds } = await limiter.run(
            () =>
              executeBatchTranslation({
                service,
                items: rawMsg.items,
                glossary: settings.glossary,
                sourceLang,
                targetLang,
                docTitle: rawMsg.docTitle,
                signal: controller.signal,
                onItemDelta: (id, fullText) => {
                  safePost({
                    type: 'ITEM_DELTA',
                    requestId: rawMsg.requestId,
                    id,
                    fullText,
                    serviceId: service.id,
                    serviceName: service.name,
                  });
                },
                onItemDone: (id, fullText) => {
                  safePost({
                    type: 'ITEM_DONE',
                    requestId: rawMsg.requestId,
                    id,
                    fullText,
                    serviceId: service.id,
                    serviceName: service.name,
                  });
                },
              }),
            controller.signal,
          );

          // Budgeted fallback recovery if the model dropped 1-2 IDs in a multi-item batch
          const missingItems = rawMsg.items.filter(
            (item) => !completedIds.has(item.id),
          );

          if (missingItems.length > 0 && !controller.signal.aborted) {
            const retrySlice = missingItems.slice(0, 2);
            const failRest = missingItems.slice(2);

            for (const skipped of failRest) {
              safePost({
                type: 'ITEM_ERROR',
                requestId: rawMsg.requestId,
                id: skipped.id,
                error: '模型未返回该段译文，点击可单独重试',
              });
            }

            for (const singleItem of retrySlice) {
              if (controller.signal.aborted) break;
              try {
                const retryRes = await limiter.run(
                  () =>
                    executeBatchTranslation({
                      service,
                      items: [singleItem],
                      glossary: settings.glossary,
                      sourceLang,
                      targetLang,
                      docTitle: rawMsg.docTitle,
                      signal: controller.signal,
                      onItemDelta: (id, fullText) => {
                        safePost({
                          type: 'ITEM_DELTA',
                          requestId: rawMsg.requestId,
                          id,
                          fullText,
                          serviceId: service.id,
                          serviceName: service.name,
                        });
                      },
                      onItemDone: (id, fullText) => {
                        safePost({
                          type: 'ITEM_DONE',
                          requestId: rawMsg.requestId,
                          id,
                          fullText,
                          serviceId: service.id,
                          serviceName: service.name,
                        });
                      },
                    }),
                  controller.signal,
                );
                if (!retryRes.completedIds.has(singleItem.id)) {
                  safePost({
                    type: 'ITEM_ERROR',
                    requestId: rawMsg.requestId,
                    id: singleItem.id,
                    error: '未获取到有效译文，点击重试',
                  });
                }
              } catch (retryErr) {
                if (!isAbortError(retryErr)) {
                  safePost({
                    type: 'ITEM_ERROR',
                    requestId: rawMsg.requestId,
                    id: singleItem.id,
                    error:
                      retryErr instanceof Error ? retryErr.message : '翻译请求失败',
                  });
                }
              }
            }
          }

          safePost({ type: 'BATCH_COMPLETE', requestId: rawMsg.requestId });
        } catch (err) {
          if (!isAbortError(err)) {
            const errMsg = err instanceof Error ? err.message : '翻译请求失败';
            for (const item of rawMsg.items) {
              safePost({
                type: 'ITEM_ERROR',
                requestId: rawMsg.requestId,
                id: item.id,
                error: errMsg,
              });
            }
            safePost({ type: 'BATCH_COMPLETE', requestId: rawMsg.requestId });
          }
        } finally {
          inFlightControllers.delete(rawMsg.requestId);
        }
        return;
      }

      if (rawMsg.type === 'SELECTION_LOOKUP') {
        const controller = new AbortController();
        inFlightControllers.set(rawMsg.requestId, controller);

        try {
          const settings = await getSettings();
          const service = resolveServiceById(settings, rawMsg.serviceId, 'lookup');
          const sourceLang = rawMsg.sourceLang ?? settings.sourceLang;
          const targetLang = rawMsg.targetLang ?? settings.targetLang;

          const finalOutput = await executeSelectionLookup({
            service,
            selectedText: rawMsg.selectedText,
            contextText: rawMsg.contextText,
            isWordOrPhrase: rawMsg.isWordOrPhrase,
            glossary: settings.glossary,
            sourceLang,
            targetLang,
            docTitle: rawMsg.docTitle,
            signal: controller.signal,
            onDelta: (fullText) => {
              safePost({
                type: 'LOOKUP_DELTA',
                requestId: rawMsg.requestId,
                serviceId: service.id,
                serviceName: service.name,
                fullText,
              });
            },
          });

          safePost({
            type: 'LOOKUP_DONE',
            requestId: rawMsg.requestId,
            serviceId: service.id,
            serviceName: service.name,
            fullText: finalOutput,
          });
        } catch (err) {
          if (!isAbortError(err)) {
            const settings = await getSettings();
            const service = resolveServiceById(settings, rawMsg.serviceId, 'lookup');
            safePost({
              type: 'LOOKUP_ERROR',
              requestId: rawMsg.requestId,
              serviceId: service.id,
              serviceName: service.name,
              error: err instanceof Error ? err.message : '查询失败',
            });
          }
        } finally {
          inFlightControllers.delete(rawMsg.requestId);
        }
      }
    });
  });

  chrome.runtime.onMessage.addListener(
    (msg: RuntimeRequestMessage, _sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return false;

      if (msg.type === 'OPEN_OPTIONS_PAGE') {
        const url = chrome.runtime.getURL(
          msg.tab ? `/options.html#${ msg.tab }` : '/options.html',
        );
        chrome.tabs.create({ url });
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === 'TEST_SERVICE') {
        (async () => {
          try {
            await syncLocalOriginDnrRules([msg.service.baseUrl]);
            const result = await testServiceConnectivity(msg.service);
            sendResponse(result);
          } catch (err) {
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : '连接测试失败',
            });
          }
        })();
        return true;
      }

      if (msg.type === 'FETCH_MODELS') {
        (async () => {
          try {
            await syncLocalOriginDnrRules([msg.baseUrl]);
            const models = await fetchAvailableModels(msg.baseUrl, msg.apiKey);
            sendResponse({ ok: true, models });
          } catch (err) {
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : '拉取模型失败',
            });
          }
        })();
        return true;
      }

      return false;
    },
  );
});
