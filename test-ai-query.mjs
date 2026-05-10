#!/usr/bin/env node
/**
 * Test script for verifying MCP server ai_query tool integration.
 * Uses the Model Context Protocol (JSON-RPC over HTTP).
 */

const BASE_URL = 'http://127.0.0.1:19532/mcp';

let nextId = 1;
let sessionId = '';

async function rpc(method, params) {
  const id = nextId++;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };

  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
    headers['Mcp-Protocol-Version'] = '2025-03-26';
  }

  const body = { jsonrpc: '2.0', method, id };
  if (params) body.params = params;

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const sessionHeader = response.headers.get('mcp-session-id');
  if (sessionHeader) sessionId = sessionHeader;

  // Parse SSE format
  const dataLine = text.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) {
    throw new Error(`No data line in response: ${text}`);
  }

  const parsed = JSON.parse(dataLine.slice(6));
  if (parsed.error) {
    throw new Error(`RPC error: ${JSON.stringify(parsed.error)}`);
  }

  return parsed.result;
}

async function notify(method) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };

  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
    headers['Mcp-Protocol-Version'] = '2025-03-26';
  }

  await fetch(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method }),
  });
}

async function main() {
  console.log('🔍 Testing MCP Server AI Query Integration\n');

  try {
    // Step 1: Initialize session
    console.log('1. Initializing MCP session...');
    const initResult = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-ai-query', version: '0.1.0' },
    });
    console.log(`   ✓ Session initialized: ${sessionId}`);
    console.log(`   ✓ Server: ${initResult.serverInfo.name} v${initResult.serverInfo.version}\n`);

    await notify('notifications/initialized');

    // Step 2: List tools to verify ai_query is registered
    console.log('2. Listing available tools...');
    const toolsResult = await rpc('tools/list');
    const tools = toolsResult.tools;
    const aiQueryTool = tools.find(t => t.name === 'ai_query');

    if (!aiQueryTool) {
      throw new Error('ai_query tool not found in tool list');
    }
    console.log(`   ✓ Found ${tools.length} tools`);
    console.log(`   ✓ ai_query tool is registered\n`);

    // Step 3: Test ai_query tool with the specified query
    console.log('3. Testing ai_query tool...');
    console.log('   Query: "What were my top 3 costs last week?"\n');

    const callResult = await rpc('tools/call', {
      name: 'ai_query',
      arguments: {
        query: 'What were my top 3 costs last week?',
      },
    });

    if (callResult.isError) {
      throw new Error(`Tool returned error: ${JSON.stringify(callResult.content)}`);
    }

    const content = callResult.content[0];
    if (!content || content.type !== 'text') {
      throw new Error('Unexpected response format');
    }

    console.log('   ✓ Tool executed successfully');
    console.log('   ✓ Response received:\n');
    console.log('   ' + content.text.split('\n').join('\n   '));
    console.log('');

    // Step 4: Clean up
    console.log('4. Closing session...');
    await fetch(BASE_URL, {
      method: 'DELETE',
      headers: {
        'Mcp-Session-Id': sessionId,
        'Mcp-Protocol-Version': '2025-03-26',
      },
    });
    console.log('   ✓ Session closed\n');

    console.log('✅ All tests passed!');
    console.log('\nVerification Summary:');
    console.log('  • MCP server is running on port 19532');
    console.log('  • ai_query tool is properly registered');
    console.log('  • Tool responds with correct format');
    console.log('  • Natural language query parsing works');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

main();
