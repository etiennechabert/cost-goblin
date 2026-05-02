import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '@costgoblin/core';
import type { McpContext } from './context.js';
import { registerTools } from './tools/index.js';

const DEFAULT_PORT = 19532;

export interface McpHttpServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function createMcpHttpServer(ctx: McpContext, port?: number): Promise<McpHttpServer> {
  const resolvedPort = port ?? DEFAULT_PORT;

  const mcpServer = new McpServer(
    { name: 'costgoblin', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  registerTools(mcpServer, ctx);

  const transport = new StreamableHTTPServerTransport({});
  // The MCP SDK's Transport type declares onclose/onerror/onmessage as required
  // but StreamableHTTPServerTransport initializes them as undefined internally.
  // With exactOptionalPropertyTypes this is a type mismatch — cast through
  // unknown since the runtime behavior is correct.
  await mcpServer.connect(transport as unknown as Transport);

  const httpServer: Server = createServer((req, res) => {
    const url = req.url ?? '';

    if (url === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      transport.handleRequest(req, res).catch((err: unknown) => {
        logger.warn(`mcp: transport error — ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(resolvedPort, '127.0.0.1', () => { resolve(); });
  });

  return {
    port: resolvedPort,
    async close(): Promise<void> {
      await transport.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => { resolve(); });
      });
    },
  };
}
