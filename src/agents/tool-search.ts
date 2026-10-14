/** Tool Search catalog compaction for large OpenClaw, MCP, and client tool inventories. */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import type { AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import type { ToolDefinition } from "./sessions/index.js";
import { resolveToolResultFailureKind } from "./tool-result-error.js";
import {
  addClientToolsToToolCatalog,
  applyToolCatalogCompaction,
  isDirectVisibleCatalogTool,
  resolveCatalog,
} from "./tool-search-catalog.js";
import { readToolSearchCode, runCodeMode, runCodeModeChild } from "./tool-search-code-mode.js";
import {
  isToolSearchCodeModeSupported,
  resolveToolSearchConfig,
  setToolSearchCodeModeSupportedForTest,
  setToolSearchMinCodeTimeoutMsForTest,
} from "./tool-search-config.js";
import {
  applyToolSchemaDirectoryCatalog,
  MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS,
} from "./tool-search-directory.js";
import { readToolSearchRequest } from "./tool-search-request.js";
import {
  formatToolSearchControlError,
  formatToolSearchControlResult,
  prepareToolSearchDispatcherArguments,
  readToolSearchCallArgs,
  readToolSearchId,
  ToolSearchRuntime,
} from "./tool-search-runtime.js";
import {
  MAX_TOOL_SEARCH_BATCH_QUERIES,
  MAX_TOOL_SEARCH_BATCH_QUERY_BYTES,
  MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
  MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS,
  MAX_TOOL_SEARCH_RESULTS,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_CONTROL_TOOL_NAMES,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogRef,
  type ToolSearchMode,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import { jsonResult, textResult, type AnyAgentTool } from "./tools/common.js";

export {
  clearToolSearchCatalog,
  collectUniqueCatalogToolNames,
  countDeferredToolSearchCandidates,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  restrictToolSearchCatalog,
  shouldCatalogTool,
} from "./tool-search-catalog.js";
export { resolveToolSearchConfig } from "./tool-search-config.js";
export {
  buildToolSchemaDirectoryPrompt,
  resolveToolSearchCatalogTool,
} from "./tool-search-directory.js";
export {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search-types.js";
export type {
  ToolSearchCatalogEntry,
  ToolSearchCatalogRef,
  ToolSearchCatalogToolExecutor,
  ToolSearchConfig,
  ToolSearchToolContext,
} from "./tool-search-types.js";

type ToolSearchCandidate = Awaited<ReturnType<ToolSearchRuntime["search"]>>[number];
type ToolSearchBatchGroup = {
  query: string;
  candidates: ToolSearchCandidate[];
  truncated?: true;
};
const MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS = 180;
const MAX_BATCH_CANDIDATE_DESCRIPTION_SCAN_CHARS = MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS * 4;
const MAX_BATCH_CANDIDATE_METADATA_CHARS = 2_000;

function compactBatchCandidateDescription(candidate: ToolSearchCandidate): ToolSearchCandidate {
  // Remote catalog descriptions are untrusted. Bound the scanned prefix before
  // normalization so repeated batch matches cannot amplify attacker-sized text.
  const prefix = truncateUtf16Safe(
    candidate.description,
    MAX_BATCH_CANDIDATE_DESCRIPTION_SCAN_CHARS,
  );
  const normalized = prefix.replace(/\s+/g, " ").trim();
  if (
    prefix.length === candidate.description.length &&
    normalized.length <= MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS
  ) {
    return { ...candidate, description: normalized };
  }
  const compacted = truncateUtf16Safe(
    normalized,
    MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS - 3,
  ).trimEnd();
  return {
    ...candidate,
    description: `${compacted}...`,
  };
}

function compactBatchCandidate(candidate: ToolSearchCandidate): ToolSearchCandidate | undefined {
  // Callable identity must stay exact. Optional provenance/display metadata is
  // omitted when it would make a repeated batch candidate attacker-sized.
  const mandatoryChars =
    candidate.id.length + candidate.source.length + candidate.name.length + candidate.input.length;
  if (mandatoryChars > MAX_BATCH_CANDIDATE_METADATA_CHARS) {
    return undefined;
  }
  let remaining = MAX_BATCH_CANDIDATE_METADATA_CHARS - mandatoryChars;
  const retain = (value: string | undefined): string | undefined => {
    if (value === undefined || value.length > remaining) {
      return undefined;
    }
    remaining -= value.length;
    return value;
  };
  const sourceName = retain(candidate.sourceName);
  const label = retain(candidate.label);
  const mcpChars = candidate.mcp
    ? candidate.mcp.serverName.length +
      candidate.mcp.safeServerName.length +
      candidate.mcp.toolName.length +
      candidate.mcp.operation.length
    : 0;
  const mcp = candidate.mcp && mcpChars <= remaining ? candidate.mcp : undefined;
  if (mcp) {
    remaining -= mcpChars;
  }
  const output = retain(candidate.output);
  return {
    ...compactBatchCandidateDescription(candidate),
    sourceName,
    label,
    mcp,
    output,
  };
}

function formatToolSearchBatchResponse(results: ToolSearchBatchGroup[]): AgentToolResult<{
  results: ToolSearchBatchGroup[];
  truncated?: true;
}> {
  const bounded: ToolSearchBatchGroup[] = results.map((result) => {
    const candidates = result.candidates
      .map(compactBatchCandidate)
      .filter((candidate): candidate is ToolSearchCandidate => candidate !== undefined);
    const groupTruncated = candidates.length < result.candidates.length;
    return {
      ...result,
      candidates,
      ...(groupTruncated ? { truncated: true as const } : {}),
    };
  });
  let truncated = bounded.some((result) => result.truncated);
  const render = () => ({ results: bounded, ...(truncated ? { truncated: true as const } : {}) });
  let payload = render();
  let text = JSON.stringify(payload, null, 2);
  while (text.length > MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS) {
    let removable: ToolSearchBatchGroup | undefined;
    for (const group of bounded) {
      if (group.candidates.length === 0) {
        continue;
      }
      // Keep the earlier request on exact ties, matching the batch's stable order.
      if (
        !removable ||
        group.candidates.length > removable.candidates.length ||
        (group.candidates.length === removable.candidates.length &&
          JSON.stringify(group.candidates.at(-1)).length >
            JSON.stringify(removable.candidates.at(-1)).length)
      ) {
        removable = group;
      }
    }
    if (!removable) {
      break;
    }
    removable.candidates.pop();
    removable.truncated = true;
    truncated = true;
    payload = render();
    text = JSON.stringify(payload, null, 2);
  }
  return textResult(text, payload);
}

function shouldExposeControlTool(name: string, mode: ToolSearchMode): boolean {
  if (name === TOOL_SEARCH_CODE_MODE_TOOL_NAME) {
    return mode === "code";
  }
  if (
    name === TOOL_SEARCH_RAW_TOOL_NAME ||
    name === TOOL_DESCRIBE_RAW_TOOL_NAME ||
    name === TOOL_CALL_RAW_TOOL_NAME
  ) {
    return mode === "tools";
  }
  return false;
}

/** Replace visible tools with Tool Search controls and register hidden catalog entries. */
export function applyToolSearchCatalog(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
  shouldCatalogTool?: (tool: AnyAgentTool) => boolean;
  directToolNames?: Iterable<string>;
}) {
  const config = resolveToolSearchConfig(params.config);
  const directToolNames = new Set(normalizeStringEntries(Array.from(params.directToolNames ?? [])));
  return applyToolCatalogCompaction({
    ...params,
    enabled: config.enabled,
    isVisibleControlTool: (tool) =>
      TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name) &&
      shouldExposeControlTool(tool.name, config.mode),
    isVisibleCatalogTool: (tool) => isDirectVisibleCatalogTool(tool, directToolNames),
  });
}

export { applyToolSchemaDirectoryCatalog };

/** Move client-provided tools into an existing Tool Search catalog. */
export function addClientToolsToToolSearchCatalog(params: {
  tools: ToolDefinition[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
}): { tools: ToolDefinition[]; compacted: boolean; catalogToolCount: number } {
  const config = resolveToolSearchConfig(params.config);
  if (config.mode === "directory") {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  return addClientToolsToToolCatalog({ ...params, enabled: config.enabled });
}

/** Create Tool Search control tools for the current run/session context. */
export function createToolSearchTools(ctx: ToolSearchToolContext): AnyAgentTool[] {
  const config = resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config);
  const runtime = new ToolSearchRuntime(ctx, config, { validateInput: true });
  return [
    {
      name: TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      label: "Tool Search Code",
      description:
        "Run JS in an isolated Node subprocess over the tool catalog via `openclaw.tools.search|describe|call`. Search queries must be English (lexical match on English names/descriptions). Call returns `{ tool, result }` with JSON usually in `result.details`.",
      parameters: Type.Object({
        code: Type.String({
          description:
            "JavaScript body for an async function; use return for the final value. `openclaw.tools` is available.",
        }),
      }),
      execute: async (
        toolCallId: string,
        args: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
      ): Promise<AgentToolResult<unknown>> => {
        let executionRuntime: ToolSearchRuntime | undefined;
        try {
          const result = await runCodeMode({
            toolCallId,
            ctx,
            code: readToolSearchCode(args),
            config,
            signal,
            onUpdate,
            onRuntime: (value) => {
              executionRuntime = value;
            },
          });
          return formatToolSearchControlResult(result, executionRuntime);
        } catch (error) {
          throw formatToolSearchControlError(
            error,
            executionRuntime,
            toolCallId,
            signal ?? ctx.abortSignal,
          );
        }
      },
    },
    {
      name: TOOL_SEARCH_RAW_TOOL_NAME,
      label: "Tool Search",
      description:
        "Search the Tool Search catalog (English queries; lexical match on English names/descriptions). Use query or queries (batch, request order); pass an exact id/name to tool_call; tool_describe only when you need the input schema.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.Union([Type.String(), Type.Null()], {
            description:
              "Single English search query. Non-empty joins a non-empty batch first. Null/blank ignored beside a batch.",
          }),
        ),
        limit: Type.Optional(
          Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
            description:
              "Max single-search results (default when omitted/null). With only batch queries, omit or null; set limits per batch entry.",
          }),
        ),
        queries: Type.Optional(
          Type.Union(
            [
              // Let the parser handle empty or null batch placeholders beside a scalar.
              Type.Array(
                Type.Object({
                  query: Type.String({
                    minLength: 1,
                    maxLength: MAX_TOOL_SEARCH_BATCH_QUERY_GRAPHEMES,
                    description: "English search query describing the capability needed.",
                  }),
                  limit: Type.Optional(
                    Type.Integer({
                      minimum: 1,
                      description: `Max results for this query (default ${config.searchDefaultLimit}).`,
                    }),
                  ),
                }),
                { maxItems: MAX_TOOL_SEARCH_BATCH_QUERIES },
              ),
              Type.Null(),
            ],
            {
              description: `Independent searches (prefer alone for several). Effective limits total ≤${MAX_TOOL_SEARCH_RESULTS}; omitted item limit=${config.searchDefaultLimit}. Serialized queries ≤${MAX_TOOL_SEARCH_BATCH_QUERY_BYTES} UTF-8 bytes.`,
            },
          ),
        ),
      }),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> => {
        const request = readToolSearchRequest(args, config);
        if (request.kind === "single") {
          return jsonResult(
            await runtime.search(request.search.query, { limit: request.search.limit }),
          );
        }
        const results = await Promise.all(
          request.searches.map(async (search) => ({
            query: search.query,
            candidates: await runtime.search(search.query, { limit: search.limit }),
          })),
        );
        return formatToolSearchBatchResponse(results);
      },
    },
    {
      name: TOOL_DESCRIBE_RAW_TOOL_NAME,
      label: "Tool Describe",
      description:
        "Load the full schema and metadata for one search result when its input is not already clear.",
      parameters: Type.Object({
        id: Type.String({ description: "Tool search result id or tool name." }),
      }),
      prepareArguments: prepareToolSearchDispatcherArguments,
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> =>
        jsonResult(await runtime.describe(readToolSearchId(args))),
    },
    {
      name: TOOL_CALL_RAW_TOOL_NAME,
      label: "Tool Call",
      description: "Call an exact Tool Search result id or name through OpenClaw.",
      parameters: Type.Object({
        id: Type.String({ description: "Tool search result id or tool name." }),
        args: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), { description: "Tool input." }),
        ),
      }),
      prepareArguments: prepareToolSearchDispatcherArguments,
      execute: async (
        toolCallId: string,
        args: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
      ): Promise<AgentToolResult<unknown>> => {
        const call = readToolSearchCallArgs(args, resolveCatalog(ctx));
        try {
          const callResult = await runtime.call(call.id, call.input, {
            parentToolCallId: toolCallId,
            signal,
            onUpdate,
          });
          const { id, name, source } = callResult.tool;
          // Invocation results need identity, not another copy of the discovery metadata.
          // Keep full metadata in details for callers and the unchanged target result on both surfaces.
          const wrappedResult = {
            ...formatToolSearchControlResult(
              { tool: { id, name, source }, result: callResult.result },
              runtime,
              { parentToolCallId: toolCallId },
            ),
            details: callResult,
          };
          const failureKind = resolveToolResultFailureKind(callResult.result);
          if (!failureKind) {
            return wrappedResult;
          }
          // Keep the model-visible `{ tool, result }` envelope stable while the
          // outer lifecycle reads its own canonical failure marker from details.
          return { ...wrappedResult, details: { ...callResult, status: failureKind } };
        } catch (error) {
          throw formatToolSearchControlError(error, runtime, toolCallId, signal ?? ctx.abortSignal);
        }
      },
    },
  ];
}

const testing = {
  maxToolSchemaDirectoryPromptChars: MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS,
  resolveToolSearchConfig,
  isToolSearchCodeModeSupported,
  setToolSearchCodeModeSupportedForTest,
  setToolSearchMinCodeTimeoutMsForTest,
  applyToolSearchCatalog,
  addClientToolsToToolSearchCatalog,
  runCodeModeChild,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.toolSearchTestApi")] = testing;
}
