#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from './schema.js';
import { SwitchboardApiError, SwitchboardClient } from './client.js';
import { TOOLS } from './tools.js';

/**
 * Switchboard's MCP server: feature flags as agent tools.
 *
 * Deliberately a thin layer over the existing REST API, with no backend surface of its own. It
 * authenticates with a personal access token, which means an agent gets exactly the permissions of
 * the person whose token it holds, enforced by the same RBAC a browser request goes through.
 *
 * Configuration is environment only — stdio servers have no other channel:
 *   SWITCHBOARD_TOKEN     required, an sb_pat_ personal access token
 *   SWITCHBOARD_BASE_URL  defaults to http://localhost:28080
 */

const TOKEN = process.env['SWITCHBOARD_TOKEN'];
const BASE_URL = process.env['SWITCHBOARD_BASE_URL'] ?? 'http://localhost:28080';

if (!TOKEN) {
  // stdout is the protocol channel, so anything human-facing goes to stderr or it corrupts the
  // stream. Exiting is right: a server with no credential can answer nothing.
  process.stderr.write(
    'SWITCHBOARD_TOKEN is required. Create a personal access token in Settings > Tokens.\n',
  );
  process.exit(1);
}

const client = new SwitchboardClient({ baseUrl: BASE_URL, token: TOKEN });

const server = new Server(
  { name: 'switchboard', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
    };
  }

  const parsed = tool.schema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
        },
      ],
    };
  }

  try {
    const result = await tool.run(client, parsed.data as never);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    // Errors come back as tool results rather than protocol errors, so the model can read what
    // went wrong and act on it — a 409 in particular is recoverable by re-reading and retrying.
    const message =
      error instanceof SwitchboardApiError
        ? `${error.message}${error.body ? `\n${error.body}` : ''}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`switchboard-mcp connected to ${BASE_URL}\n`);
