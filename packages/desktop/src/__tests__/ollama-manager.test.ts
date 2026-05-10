import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOllamaManager } from '../main/ollama-manager.js';
import type { OllamaManager } from '../main/ollama-manager.js';
import { asModelName } from '@costgoblin/core';

const mockFetch = vi.fn();

// Mock global fetch
global.fetch = mockFetch;

describe('OllamaManager - checkStatus', () => {
  let manager: OllamaManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createOllamaManager();
  });

  afterEach(() => {
    manager.terminate();
  });

  it('returns connected status when Ollama is running', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    const status = await manager.checkStatus();

    expect(status).toEqual({
      state: 'connected',
      version: '0.1.17',
    });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns disconnected status when Ollama is not running', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));

    const status = await manager.checkStatus();

    expect(status).toEqual({
      state: 'disconnected',
      error: 'fetch failed: ECONNREFUSED',
    });
  });

  it('caches status for subsequent calls within TTL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    const status1 = await manager.checkStatus();
    const status2 = await manager.checkStatus();

    expect(status1).toEqual(status2);
    expect(mockFetch).toHaveBeenCalledOnce(); // Only called once, second is cached
  });

  it('respects custom cache TTL', async () => {
    const shortTtlManager = createOllamaManager({ statusCacheTtlMs: 10 });

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    await shortTtlManager.checkStatus();

    // Wait for cache to expire
    await new Promise(resolve => setTimeout(resolve, 15));

    await shortTtlManager.checkStatus();

    expect(mockFetch).toHaveBeenCalledTimes(2); // Called twice after cache expires

    shortTtlManager.terminate();
  });

  it('uses custom base URL when provided', async () => {
    const customManager = createOllamaManager({ baseUrl: 'http://remote-host:8080' });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    await customManager.checkStatus();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://remote-host:8080/api/version',
      expect.objectContaining({})
    );

    customManager.terminate();
  });

  it('invalidates status cache when requested', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    await manager.checkStatus();
    manager.invalidateCache();
    await manager.checkStatus();

    expect(mockFetch).toHaveBeenCalledTimes(2); // Called twice after invalidation
  });
});

describe('OllamaManager - listModels', () => {
  let manager: OllamaManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createOllamaManager();
  });

  afterEach(() => {
    manager.terminate();
  });

  it('returns list of available models', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        models: [
          {
            name: 'llama3.2:3b',
            modified_at: '2024-01-01T00:00:00Z',
            size: 2000000000,
            digest: 'abc123',
            details: {
              format: 'gguf',
              family: 'llama',
              families: null,
              parameter_size: '3B',
              quantization_level: 'Q4_0',
            },
          },
          {
            name: 'mistral:7b',
            modified_at: '2024-01-02T00:00:00Z',
            size: 4000000000,
            digest: 'def456',
            details: {
              format: 'gguf',
              family: 'mistral',
              families: null,
              parameter_size: '7B',
              quantization_level: 'Q4_0',
            },
          },
        ],
      }),
    });

    const models = await manager.listModels();

    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      name: asModelName('llama3.2:3b'),
      size: 2000000000,
      format: 'gguf',
      family: 'llama',
      modifiedAt: '2024-01-01T00:00:00Z',
    });
    expect(models[1]).toEqual({
      name: asModelName('mistral:7b'),
      size: 4000000000,
      format: 'gguf',
      family: 'mistral',
      modifiedAt: '2024-01-02T00:00:00Z',
    });
  });

  it('caches models list for subsequent calls within TTL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        models: [
          {
            name: 'llama3.2:3b',
            modified_at: '2024-01-01T00:00:00Z',
            size: 2000000000,
            digest: 'abc123',
            details: {
              format: 'gguf',
              family: 'llama',
              families: null,
              parameter_size: '3B',
              quantization_level: 'Q4_0',
            },
          },
        ],
      }),
    });

    const models1 = await manager.listModels();
    const models2 = await manager.listModels();

    expect(models1).toEqual(models2);
    expect(mockFetch).toHaveBeenCalledOnce(); // Only called once, second is cached
  });

  it('respects custom models cache TTL', async () => {
    const shortTtlManager = createOllamaManager({ modelsCacheTtlMs: 10 });

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [
          {
            name: 'llama3.2:3b',
            modified_at: '2024-01-01T00:00:00Z',
            size: 2000000000,
            digest: 'abc123',
            details: {
              format: 'gguf',
              family: 'llama',
              families: null,
              parameter_size: '3B',
              quantization_level: 'Q4_0',
            },
          },
        ],
      }),
    });

    await shortTtlManager.listModels();

    // Wait for cache to expire
    await new Promise(resolve => setTimeout(resolve, 15));

    await shortTtlManager.listModels();

    expect(mockFetch).toHaveBeenCalledTimes(2); // Called twice after cache expires

    shortTtlManager.terminate();
  });

  it('invalidates models cache when requested', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [
          {
            name: 'llama3.2:3b',
            modified_at: '2024-01-01T00:00:00Z',
            size: 2000000000,
            digest: 'abc123',
            details: {
              format: 'gguf',
              family: 'llama',
              families: null,
              parameter_size: '3B',
              quantization_level: 'Q4_0',
            },
          },
        ],
      }),
    });

    await manager.listModels();
    manager.invalidateCache();
    await manager.listModels();

    expect(mockFetch).toHaveBeenCalledTimes(2); // Called twice after invalidation
  });

  it('throws error when API returns non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(manager.listModels()).rejects.toThrow('Failed to list models: HTTP 500 Internal Server Error');
  });
});

describe('OllamaManager - generate', () => {
  let manager: OllamaManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createOllamaManager();
  });

  afterEach(() => {
    manager.terminate();
  });

  it('generates text with non-streaming mode', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        model: 'llama3.2:3b',
        created_at: '2024-01-01T00:00:00Z',
        response: 'Generated text response',
        done: true,
        total_duration: 1000000000,
        load_duration: 100000000,
        prompt_eval_count: 10,
        eval_count: 20,
      }),
    });

    const response = await manager.generate({
      model: asModelName('llama3.2:3b'),
      prompt: 'Test prompt',
      stream: false,
    });

    expect(response).toEqual({
      text: 'Generated text response',
      model: asModelName('llama3.2:3b'),
      createdAt: '2024-01-01T00:00:00Z',
      totalDuration: 1000000000,
      loadDuration: 100000000,
      promptEvalCount: 10,
      evalCount: 20,
    });
  });

  it('generates text with streaming mode', async () => {
    const chunks = [
      { model: 'llama3.2:3b', created_at: '2024-01-01T00:00:00Z', response: 'Hello', done: false },
      { model: 'llama3.2:3b', created_at: '2024-01-01T00:00:00Z', response: ' world', done: false },
      {
        model: 'llama3.2:3b',
        created_at: '2024-01-01T00:00:00Z',
        response: '!',
        done: true,
        total_duration: 1000000000,
        load_duration: 100000000,
        prompt_eval_count: 10,
        eval_count: 20,
      },
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(JSON.stringify(chunk) + '\n'));
        }
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: stream,
    });

    const onChunk = vi.fn();
    const response = await manager.generate(
      {
        model: asModelName('llama3.2:3b'),
        prompt: 'Test prompt',
        stream: true,
      },
      { onChunk }
    );

    expect(response.text).toBe('Hello world!');
    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk).toHaveBeenCalledWith('Hello');
    expect(onChunk).toHaveBeenCalledWith(' world');
    expect(onChunk).toHaveBeenCalledWith('!');
  });

  it('handles generation errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(
      manager.generate({
        model: asModelName('llama3.2:3b'),
        prompt: 'Test prompt',
        stream: false,
      })
    ).rejects.toThrow('Network error');
  });

  it('handles abort signal for cancellation', async () => {
    const controller = new AbortController();

    // Simulate a slow response
    mockFetch.mockImplementationOnce(() =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve({
            ok: true,
            json: () => Promise.resolve({ response: 'Too slow', done: true }),
          });
        }, 200);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new Error('Request aborted'));
        });
      })
    );

    // Abort after 50ms
    setTimeout(() => {
      controller.abort();
    }, 50);

    await expect(
      manager.generate(
        {
          model: asModelName('llama3.2:3b'),
          prompt: 'Test prompt',
          stream: false,
        },
        { signal: controller.signal }
      )
    ).rejects.toThrow('Request aborted');
  });
});

describe('OllamaManager - lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears all caches on terminate', async () => {
    const manager = createOllamaManager();

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    await manager.checkStatus();
    manager.terminate();
    await manager.checkStatus(); // Should fetch again after terminate

    expect(mockFetch).toHaveBeenCalledTimes(2);
    manager.terminate();
  });

  it('can be used after terminate', async () => {
    const manager = createOllamaManager();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    await manager.checkStatus();
    manager.terminate();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.18' }),
    });

    const status = await manager.checkStatus();

    expect(status).toEqual({
      state: 'connected',
      version: '0.1.18',
    });

    manager.terminate();
  });
});
