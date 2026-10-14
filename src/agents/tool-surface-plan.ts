import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import {
  applyCodeModeCatalog,
  isCodeModeEngagedForModel,
  resolveCodeModeConfig,
} from "./code-mode.js";
import { normalizeToolPolicyName, readToolAllowlistIntersection } from "./tool-policy-shared.js";
import {
  applyLargeCatalogToolSearchOverlay,
  AUTO_TOOL_SEARCH_DEFERRED_THRESHOLD,
  isToolSearchConfigExplicit,
  resolveAgentToolSearchRuntimeConfig,
  shouldUseLocalToolSearchAuto,
} from "./tool-search-runtime-config.js";
import type { ToolSearchConfig } from "./tool-search-types.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "./tool-search-types.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  countDeferredToolSearchCandidates,
  resolveToolSearchConfig,
} from "./tool-search.js";
import type { AnyAgentTool } from "./tools/common.js";

type AgentToolSurfacePlanParams = {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  forceDirectMessageTool: boolean;
  model?: { compat?: unknown; toolSearchMode?: "tools" | false };
  modelProvider?: string;
  modelId?: string;
  codeModeOverride?: boolean | "auto";
  disableToolSearch?: true;
  toolsEnabled: boolean;
  disableTools?: boolean;
  isRawModelRun: boolean;
  toolsAllow?: readonly string[];
  forceCodeModeControls?: boolean;
};

export function resolveAgentToolSurfacePlan(params: AgentToolSurfacePlanParams) {
  const restrictions = params.toolsAllow
    ? (readToolAllowlistIntersection(params.toolsAllow) ?? [params.toolsAllow])
    : [];
  // Private completion replies have one message capability. Ordinary forced
  // delivery keeps message direct while other tools can still use discovery.
  const completionPrivateMessageOnly =
    params.forceDirectMessageTool &&
    restrictions.some(
      (allow) => allow.length === 1 && normalizeToolPolicyName(allow[0] ?? "") === "message",
    );
  const codeModeConfig = resolveCodeModeConfig(
    params.config,
    params.agentId,
    params.modelProvider && params.modelId
      ? { provider: params.modelProvider, modelId: params.modelId }
      : undefined,
  );
  codeModeConfig.enabled = params.codeModeOverride ?? codeModeConfig.enabled;
  const selectedToolConfig = resolveAgentToolSearchRuntimeConfig({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    completionPrivateMessageOnly,
    model: params.model,
  });
  const toolSearchExplicit = isToolSearchConfigExplicit(selectedToolConfig);
  const localToolSearchAuto =
    !toolSearchExplicit &&
    !completionPrivateMessageOnly &&
    shouldUseLocalToolSearchAuto({
      config: selectedToolConfig,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      model: params.model,
    });
  const toolSearchOptedOut = params.model?.toolSearchMode === false;
  // Apply invocation restrictions after selecting the current runtime snapshot;
  // config rebinding must not put an auxiliary direct-tool run back behind discovery.
  const toolsAvailable =
    params.toolsEnabled &&
    getActiveAgentRingZeroTools().length === 0 &&
    params.disableTools !== true &&
    !params.isRawModelRun &&
    restrictions.every((allow) => allow.length > 0) &&
    !completionPrivateMessageOnly;
  const codeModeControlsEnabled =
    toolsAvailable &&
    // Restart recovery continues one provider turn. Keep its original control
    // schema even when the reloaded config disables Code Mode for new turns.
    (params.forceCodeModeControls === true ||
      isCodeModeEngagedForModel(codeModeConfig, params.model));
  // Unset configs arm directory Tool Search until compact confirms a large catalog.
  const toolSearchAutoArmed =
    toolsAvailable &&
    !codeModeControlsEnabled &&
    params.disableToolSearch !== true &&
    !toolSearchExplicit &&
    !localToolSearchAuto &&
    !toolSearchOptedOut;
  const selectedWithLargeCatalogArm = toolSearchAutoArmed
    ? applyLargeCatalogToolSearchOverlay(selectedToolConfig)
    : selectedToolConfig;
  const toolSearchRuntimeConfig = params.disableToolSearch
    ? {
        ...selectedWithLargeCatalogArm,
        tools: { ...selectedWithLargeCatalogArm?.tools, toolSearch: false as const },
      }
    : selectedWithLargeCatalogArm;
  const toolSearchConfig = resolveToolSearchConfig(toolSearchRuntimeConfig);
  const toolSearchControlsEnabled =
    toolsAvailable && !codeModeControlsEnabled && toolSearchConfig.enabled;
  return {
    codeModeControlsEnabled,
    toolSearchControlsEnabled,
    toolSearchAutoArmed,
    toolSearchConfig,
    toolSearchRuntimeConfig,
  };
}

type CodeModeCatalogParams = Parameters<typeof applyCodeModeCatalog>[0];
type ApplyAgentToolSurfaceCatalogParams = Omit<CodeModeCatalogParams, "directToolNames"> & {
  /** Required key (may be undefined for a config-less run): the tool-search
   * branches resolve their mode from this, so omitting it would silently
   * downgrade the run to schema defaults. */
  toolSearchRuntimeConfig: OpenClawConfig | undefined;
  codeModeControlsEnabled: boolean;
  toolSearchConfig: ToolSearchConfig;
  forceDirectMessageTool: boolean;
  /** When true, compact only if deferred-eligible tools meet the auto threshold. */
  toolSearchAutoArmed?: boolean;
};

function stripToolSearchControls(tools: AnyAgentTool[]) {
  return tools.filter((tool) => !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name));
}

export function applyAgentToolSurfaceCatalog({
  codeModeControlsEnabled,
  toolSearchConfig,
  toolSearchRuntimeConfig,
  forceDirectMessageTool,
  toolSearchAutoArmed = false,
  ...catalogParams
}: ApplyAgentToolSurfaceCatalogParams) {
  // When the message tool is the only reply path it must stay directly visible
  // in every search mode; a hidden delivery tool can leave the run mute.
  const directToolNames = forceDirectMessageTool ? ["message"] : [];
  if (codeModeControlsEnabled) {
    return applyCodeModeCatalog({
      ...catalogParams,
      config: catalogParams.config,
      directToolNames,
    });
  }
  if (toolSearchAutoArmed) {
    const deferredCount = countDeferredToolSearchCandidates(
      catalogParams.tools,
      new Set(directToolNames),
    );
    if (deferredCount < AUTO_TOOL_SEARCH_DEFERRED_THRESHOLD) {
      return {
        tools: stripToolSearchControls(catalogParams.tools),
        compacted: false,
        catalogToolCount: 0,
        catalogRegistered: false,
        catalogReused: false,
      };
    }
  }
  const applyCatalog =
    toolSearchConfig.mode === "directory"
      ? applyToolSchemaDirectoryCatalog
      : applyToolSearchCatalog;
  return applyCatalog({
    ...catalogParams,
    config: toolSearchRuntimeConfig,
    directToolNames,
  });
}
