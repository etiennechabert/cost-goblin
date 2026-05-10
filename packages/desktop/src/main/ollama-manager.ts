import { logger, createOllamaHandle } from '@costgoblin/core';
import type { OllamaStatus, AIModel } from '@costgoblin/core';
import type { OllamaHandle, GenerateRequest, GenerateOptions, GenerateResponse } from '@costgoblin/core';

export interface OllamaManagerOptions {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly statusCacheTtlMs?: number | undefined;
  readonly modelsCacheTtlMs?: number | undefined;
}

export interface OllamaManager {
  checkStatus(): Promise<OllamaStatus>;
  listModels(): Promise<readonly AIModel[]>;
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse>;
  invalidateCache(): void;
  terminate(): void;
}

interface CachedStatus {
  readonly status: OllamaStatus;
  readonly cachedAt: number;
}

interface CachedModels {
  readonly models: readonly AIModel[];
  readonly cachedAt: number;
}

export function createOllamaManager(options?: OllamaManagerOptions): OllamaManager {
  const statusCacheTtlMs = options?.statusCacheTtlMs ?? 30000; // 30 seconds default
  const modelsCacheTtlMs = options?.modelsCacheTtlMs ?? 300000; // 5 minutes default

  const handle: OllamaHandle = createOllamaHandle({
    baseUrl: options?.baseUrl,
    timeoutMs: options?.timeoutMs,
  });

  let cachedStatus: CachedStatus | null = null;
  let cachedModels: CachedModels | null = null;

  return {
    async checkStatus(): Promise<OllamaStatus> {
      const now = Date.now();

      // Return cached status if still valid
      if (cachedStatus !== null && now - cachedStatus.cachedAt < statusCacheTtlMs) {
        logger.debug('ollama:status-cache-hit', {
          state: cachedStatus.status.state,
          cacheAgeMs: now - cachedStatus.cachedAt,
        });
        return cachedStatus.status;
      }

      // Fetch fresh status
      const startedAt = Date.now();
      const status = await handle.checkStatus();
      const durationMs = Date.now() - startedAt;

      cachedStatus = {
        status,
        cachedAt: now,
      };

      logger.debug('ollama:status-check', {
        state: status.state,
        durationMs,
        ...(status.state === 'connected' ? { version: status.version } : { error: status.error }),
      });

      return status;
    },

    async listModels(): Promise<readonly AIModel[]> {
      const now = Date.now();

      // Return cached models if still valid
      if (cachedModels !== null && now - cachedModels.cachedAt < modelsCacheTtlMs) {
        logger.debug('ollama:models-cache-hit', {
          count: cachedModels.models.length,
          cacheAgeMs: now - cachedModels.cachedAt,
        });
        return cachedModels.models;
      }

      // Fetch fresh models list
      const startedAt = Date.now();
      const models = await handle.listModels();
      const durationMs = Date.now() - startedAt;

      cachedModels = {
        models,
        cachedAt: now,
      };

      logger.debug('ollama:models-listed', {
        count: models.length,
        durationMs,
        models: models.map(m => m.name),
      });

      return models;
    },

    async generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse> {
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();

      try {
        const response = await handle.generate(request, options);
        const durationMs = Date.now() - startedAt;

        logger.debug('ollama:generate-complete', {
          model: request.model,
          startedAt: startedAtIso,
          durationMs,
          textLength: response.text.length,
          stream: request.stream,
          totalDuration: response.totalDuration,
          promptEvalCount: response.promptEvalCount,
          evalCount: response.evalCount,
        });

        return response;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : 'Unknown error';

        logger.debug('ollama:generate-failed', {
          model: request.model,
          startedAt: startedAtIso,
          durationMs,
          error: message,
          stream: request.stream,
        });

        throw error;
      }
    },

    invalidateCache(): void {
      cachedStatus = null;
      cachedModels = null;
      logger.debug('ollama:cache-invalidated', {});
    },

    terminate(): void {
      cachedStatus = null;
      cachedModels = null;
      logger.debug('ollama:manager-terminated', {});
    },
  };
}
