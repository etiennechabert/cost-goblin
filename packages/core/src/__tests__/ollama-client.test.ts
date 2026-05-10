import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOllamaHandle } from '../ai/ollama-client.js';
import { asModelName } from '../ai/types.js';
import type { OllamaHandle } from '../ai/ollama-client.js';

const mockFetch = vi.fn();

// Mock global fetch
global.fetch = mockFetch;

describe('Ollama client - checkStatus', () => {
  let ollama: OllamaHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    ollama = createOllamaHandle();
  });

  it('returns connected status when Ollama is running', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    const status = await ollama.checkStatus();

    expect(status).toEqual({
      state: 'connected',
      version: '0.1.17',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/version',
      expect.objectContaining({})
    );
  });

  it('returns disconnected status when Ollama is not running', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));

    const status = await ollama.checkStatus();

    expect(status).toEqual({
      state: 'disconnected',
      error: 'fetch failed: ECONNREFUSED',
    });
  });

  it('returns disconnected status on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const status = await ollama.checkStatus();

    expect(status).toEqual({
      state: 'disconnected',
      error: 'HTTP 500: Internal Server Error',
    });
  });

  it('uses custom base URL when provided', async () => {
    const customOllama = createOllamaHandle({ baseUrl: 'http://remote-host:8080' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    await customOllama.checkStatus();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://remote-host:8080/api/version',
      expect.objectContaining({})
    );
  });

  it('handles non-Error thrown values', async () => {
    mockFetch.mockRejectedValueOnce('string error');

    const status = await ollama.checkStatus();

    expect(status.state).toBe('disconnected');
    expect(status).toHaveProperty('error');
  });
});

describe('Ollama client - listModels', () => {
  let ollama: OllamaHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    ollama = createOllamaHandle();
  });

  it('returns list of available models', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        models: [
          {
            name: 'llama3.2:3b',
            modified_at: '2024-10-15T10:30:00Z',
            size: 2000000000,
            digest: 'sha256:abc123',
            details: {
              format: 'gguf',
              family: 'llama',
              families: ['llama'],
              parameter_size: '3B',
              quantization_level: 'Q4_0',
            },
          },
          {
            name: 'mistral:7b',
            modified_at: '2024-10-10T08:00:00Z',
            size: 4100000000,
            digest: 'sha256:def456',
            details: {
              format: 'gguf',
              family: 'mistral',
              families: ['mistral'],
              parameter_size: '7B',
              quantization_level: 'Q4_K_M',
            },
          },
        ],
      }),
    });

    const models = await ollama.listModels();

    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      name: asModelName('llama3.2:3b'),
      size: 2000000000,
      format: 'gguf',
      family: 'llama',
      modifiedAt: '2024-10-15T10:30:00Z',
    });
    expect(models[1]).toEqual({
      name: asModelName('mistral:7b'),
      size: 4100000000,
      format: 'gguf',
      family: 'mistral',
      modifiedAt: '2024-10-10T08:00:00Z',
    });
  });

  it('returns empty array when no models installed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const models = await ollama.listModels();

    expect(models).toHaveLength(0);
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(ollama.listModels()).rejects.toThrow(
      'Failed to list models: HTTP 500 Internal Server Error'
    );
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(ollama.listModels()).rejects.toThrow('Network error');
  });

  it('calls correct endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    await ollama.listModels();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({})
    );
  });
});

describe('Ollama client - generate (non-streaming)', () => {
  let ollama: OllamaHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    ollama = createOllamaHandle();
  });

  it('generates text completion', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'The total cost for EC2 last month was $1,234.56.',
        done: true,
        total_duration: 1500000000,
        load_duration: 100000000,
        prompt_eval_count: 25,
        eval_count: 15,
      }),
    });

    const result = await ollama.generate({
      model: asModelName('llama3.2:3b'),
      prompt: 'What was the total cost for EC2 last month?',
      stream: false,
    });

    expect(result).toEqual({
      text: 'The total cost for EC2 last month was $1,234.56.',
      model: asModelName('llama3.2:3b'),
      createdAt: '2024-10-15T12:00:00Z',
      totalDuration: 1500000000,
      loadDuration: 100000000,
      promptEvalCount: 25,
      evalCount: 15,
    });
  });

  it('passes generation options', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'Generated text',
        done: true,
      }),
    });

    await ollama.generate({
      model: asModelName('llama3.2:3b'),
      prompt: 'Test prompt',
      stream: false,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_predict: 100,
      },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: asModelName('llama3.2:3b'),
          prompt: 'Test prompt',
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
            num_predict: 100,
          },
        }),
      })
    );
  });

  it('handles missing optional duration fields', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'Generated text',
        done: true,
      }),
    });

    const result = await ollama.generate({
      model: asModelName('llama3.2:3b'),
      prompt: 'Test',
      stream: false,
    });

    expect(result.totalDuration).toBe(0);
    expect(result.loadDuration).toBe(0);
    expect(result.promptEvalCount).toBe(0);
    expect(result.evalCount).toBe(0);
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Model not found',
    });

    await expect(
      ollama.generate({
        model: asModelName('nonexistent:model'),
        prompt: 'Test',
        stream: false,
      })
    ).rejects.toThrow('Failed to generate: HTTP 404 Model not found');
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    mockFetch.mockRejectedValueOnce(new Error('Request aborted'));

    await expect(
      ollama.generate(
        {
          model: asModelName('llama3.2:3b'),
          prompt: 'Test',
          stream: false,
        },
        { signal: controller.signal }
      )
    ).rejects.toThrow('Request aborted');
  });
});

describe('Ollama client - generate (streaming)', () => {
  let ollama: OllamaHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    ollama = createOllamaHandle();
  });

  function createMockStreamBody(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;

    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          const chunk = chunks[index];
          if (chunk !== undefined) {
            controller.enqueue(encoder.encode(chunk + '\n'));
          }
          index++;
        } else {
          controller.close();
        }
      },
    });
  }

  it('streams text completion with chunks', async () => {
    const chunks = [
      JSON.stringify({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'The ',
        done: false,
      }),
      JSON.stringify({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'cost ',
        done: false,
      }),
      JSON.stringify({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'was $100.',
        done: true,
        total_duration: 2000000000,
        load_duration: 150000000,
        prompt_eval_count: 30,
        eval_count: 20,
      }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createMockStreamBody(chunks),
    });

    const onChunk = vi.fn();
    const result = await ollama.generate(
      {
        model: asModelName('llama3.2:3b'),
        prompt: 'What was the cost?',
        stream: true,
      },
      { onChunk }
    );

    expect(result.text).toBe('The cost was $100.');
    expect(result.model).toEqual(asModelName('llama3.2:3b'));
    expect(result.totalDuration).toBe(2000000000);
    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk).toHaveBeenNthCalledWith(1, 'The ');
    expect(onChunk).toHaveBeenNthCalledWith(2, 'cost ');
    expect(onChunk).toHaveBeenNthCalledWith(3, 'was $100.');
  });

  it('handles streaming without onChunk callback', async () => {
    const chunks = [
      JSON.stringify({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'Hello ',
        done: false,
      }),
      JSON.stringify({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'world',
        done: true,
        total_duration: 1000000000,
      }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createMockStreamBody(chunks),
    });

    const result = await ollama.generate({
      model: asModelName('llama3.2:3b'),
      prompt: 'Say hello',
      stream: true,
    });

    expect(result.text).toBe('Hello world');
  });

  it('throws when stream ends without final chunk', async () => {
    const chunks = [
      JSON.stringify({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'Incomplete',
        done: false,
      }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createMockStreamBody(chunks),
    });

    await expect(
      ollama.generate({
        model: asModelName('llama3.2:3b'),
        prompt: 'Test',
        stream: true,
      })
    ).rejects.toThrow('Stream ended without final chunk');
  });

  it('throws when response body is null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: null,
    });

    await expect(
      ollama.generate({
        model: asModelName('llama3.2:3b'),
        prompt: 'Test',
        stream: true,
      })
    ).rejects.toThrow('Response body is null for streaming request');
  });

  it('skips malformed JSON lines in stream', async () => {
    const chunks = [
      'not json',
      JSON.stringify({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'Valid ',
        done: false,
      }),
      '{incomplete json',
      JSON.stringify({
        model: 'llama3.2:3b',
        created_at: '2024-10-15T12:00:00Z',
        response: 'text',
        done: true,
        total_duration: 1000000000,
      }),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: createMockStreamBody(chunks),
    });

    const result = await ollama.generate({
      model: asModelName('llama3.2:3b'),
      prompt: 'Test',
      stream: true,
    });

    expect(result.text).toBe('Valid text');
  });

  it('handles multi-line chunks correctly', async () => {
    const encoder = new TextEncoder();
    const multiLineChunk = `${JSON.stringify({ model: 'llama3.2:3b', created_at: '2024-10-15T12:00:00Z', response: 'First ', done: false })}
${JSON.stringify({ model: 'llama3.2:3b', created_at: '2024-10-15T12:00:00Z', response: 'Second', done: true, total_duration: 1000000000 })}`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(multiLineChunk));
          controller.close();
        },
      }),
    });

    const result = await ollama.generate({
      model: asModelName('llama3.2:3b'),
      prompt: 'Test',
      stream: true,
    });

    expect(result.text).toBe('First Second');
  });
});

describe('Ollama client - timeout', () => {
  let ollama: OllamaHandle;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses custom timeout option', async () => {
    // Just verify that the option is accepted - actual timeout behavior
    // is handled by fetch's AbortController
    ollama = createOllamaHandle({ timeoutMs: 30000 });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ version: '0.1.17' }),
    });

    const status = await ollama.checkStatus();

    expect(status.state).toBe('connected');
  });
});
