import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '@costgoblin/core';
import { createDuckDBPool } from './duckdb.js';
import { createMcpContext } from './context.js';
import { registerTools } from './tools/index.js';

logger.addHandler((entry) => {
  process.stderr.write(`[costgoblin-mcp] ${entry.level}: ${entry.message}\n`);
});

const dataDir = process.env['COSTGOBLIN_DATA_DIR'];
const configDir = process.env['COSTGOBLIN_CONFIG_DIR'];

if (dataDir === undefined || dataDir.length === 0) {
  process.stderr.write('[costgoblin-mcp] COSTGOBLIN_DATA_DIR is required\n');
  process.exit(1);
}

if (configDir === undefined || configDir.length === 0) {
  process.stderr.write('[costgoblin-mcp] COSTGOBLIN_CONFIG_DIR is required\n');
  process.exit(1);
}

const resolvedDataDir: string = dataDir;
const resolvedConfigDir: string = configDir;

async function main(): Promise<void> {
  const db = await createDuckDBPool();
  const ctx = createMcpContext(db, resolvedDataDir, resolvedConfigDir);

  const server = new McpServer(
    { name: 'costgoblin', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  registerTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('costgoblin-mcp: server started', { dataDir: resolvedDataDir, configDir: resolvedConfigDir });

  void ctx.warmup();
}

main().catch((err: unknown) => {
  process.stderr.write(`[costgoblin-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
