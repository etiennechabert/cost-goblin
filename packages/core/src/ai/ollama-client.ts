import type { AIModel, ModelName, OllamaStatus } from './types.js';
import { asModelName } from './types.js';

export interface OllamaClientOptions {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface GenerateOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onChunk?: ((text: string) => void) | undefined;
}

export interface GenerateRequest {
  readonly model: ModelName;
  readonly prompt: string;
  readonly stream: boolean;
  readonly options?: {
    readonly temperature?: number | undefined;
    readonly top_p?: number | undefined;
    readonly num_predict?: number | undefined;
  } | undefined;
}

export interface GenerateResponse {
  readonly text: string;
  readonly model: ModelName;
  readonly createdAt: string;
  readonly totalDuration: number;
  readonly loadDuration: number;
  readonly promptEvalCount: number;
  readonly evalCount: number;
}

export interface OllamaHandle {
  checkStatus(): Promise<OllamaStatus>;
  listModels(): Promise<readonly AIModel[]>;
  generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse>;
}

interface OllamaTagsResponse {
  readonly models: readonly {
    readonly name: string;
    readonly modified_at: string;
    readonly size: number;
    readonly digest: string;
    readonly details: {
      readonly format: string;
      readonly family: string;
      readonly families: readonly string[] | null;
      readonly parameter_size: string;
      readonly quantization_level: string;
    };
  }[];
}

interface OllamaVersionResponse {
  readonly version: string;
}

interface OllamaGenerateChunk {
  readonly model: string;
  readonly created_at: string;
  readonly response: string;
  readonly done: boolean;
  readonly done_reason?: string | undefined;
  readonly total_duration?: number | undefined;
  readonly load_duration?: number | undefined;
  readonly prompt_eval_count?: number | undefined;
  readonly eval_count?: number | undefined;
}

export function createOllamaHandle(options?: OllamaClientOptions): OllamaHandle {
  const baseUrl = options?.baseUrl ?? 'http://localhost:11434';
  const timeoutMs = options?.timeoutMs ?? 120000; // 2 minutes default

  async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: init?.signal ?? controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    async checkStatus(): Promise<OllamaStatus> {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/api/version`);
        if (!response.ok) {
          return {
            state: 'disconnected',
            error: `HTTP ${String(response.status)}: ${response.statusText}`,
          };
        }

        const data = (await response.json()) as OllamaVersionResponse;
        return {
          state: 'connected',
          version: data.version,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          state: 'disconnected',
          error: message,
        };
      }
    },

    async listModels(): Promise<readonly AIModel[]> {
      const response = await fetchWithTimeout(`${baseUrl}/api/tags`);

      if (!response.ok) {
        throw new Error(`Failed to list models: HTTP ${String(response.status)} ${response.statusText}`);
      }

      const data = (await response.json()) as OllamaTagsResponse;

      return data.models.map(m => ({
        name: asModelName(m.name),
        size: m.size,
        format: m.details.format,
        family: m.details.family,
        modifiedAt: m.modified_at,
      }));
    },

    async generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResponse> {
      const requestInit: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          prompt: request.prompt,
          stream: request.stream,
          options: request.options,
        }),
      };

      if (options?.signal !== undefined) {
        requestInit.signal = options.signal;
      }

      const response = await fetchWithTimeout(`${baseUrl}/api/generate`, requestInit);

      if (!response.ok) {
        throw new Error(`Failed to generate: HTTP ${String(response.status)} ${response.statusText}`);
      }

      if (!request.stream) {
        const data = (await response.json()) as OllamaGenerateChunk;
        return {
          text: data.response,
          model: asModelName(data.model),
          createdAt: data.created_at,
          totalDuration: data.total_duration ?? 0,
          loadDuration: data.load_duration ?? 0,
          promptEvalCount: data.prompt_eval_count ?? 0,
          evalCount: data.eval_count ?? 0,
        };
      }

      // Streaming mode
      if (response.body === null) {
        throw new Error('Response body is null for streaming request');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let finalChunk: OllamaGenerateChunk | null = null;

      try {
        let result = await reader.read();
        while (!result.done) {
          if (result.value !== undefined) {
            const chunk = decoder.decode(result.value as Uint8Array, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim() !== '');

            for (const line of lines) {
              try {
                const parsed = JSON.parse(line) as OllamaGenerateChunk;
                fullText += parsed.response;

                if (options?.onChunk !== undefined) {
                  options.onChunk(parsed.response);
                }

                if (parsed.done) {
                  finalChunk = parsed;
                }
              } catch {
                // Skip malformed JSON lines
                continue;
              }
            }
          }
          result = await reader.read();
        }
      } finally {
        reader.releaseLock();
      }

      if (finalChunk === null) {
        throw new Error('Stream ended without final chunk');
      }

      return {
        text: fullText,
        model: asModelName(finalChunk.model),
        createdAt: finalChunk.created_at,
        totalDuration: finalChunk.total_duration ?? 0,
        loadDuration: finalChunk.load_duration ?? 0,
        promptEvalCount: finalChunk.prompt_eval_count ?? 0,
        evalCount: finalChunk.eval_count ?? 0,
      };
    },
  };
}
