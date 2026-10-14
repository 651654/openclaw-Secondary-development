// Applies Tool Search overlays on top of the selected runtime config.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isLocalModelLeanEnabled } from "./local-model-lean.js";
import { resolveAgentRuntimeToolConfig } from "./tool-runtime-config.js";

/** Deferred-eligible tools needed before unset configs auto-enable directory Tool Search. */
export const AUTO_TOOL_SEARCH_DEFERRED_THRESHOLD = 12;

export const LOCAL_AUTO_TOOL_SEARCH_OVERLAY = {
  enabled: true,
  mode: "tools",
  searchDefaultLimit: 5,
  maxSearchLimit: 10,
} as const;

export const LARGE_CATALOG_AUTO_TOOL_SEARCH_OVERLAY = {
  enabled: true,
  mode: "directory",
} as const;

export function isToolSearchConfigExplicit(config?: OpenClawConfig): boolean {
  return config?.tools?.toolSearch !== undefined;
}

export function shouldUseLocalToolSearchAuto(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  model?: { toolSearchMode?: "tools" | false };
}): boolean {
  return (
    params.model?.toolSearchMode === "tools" ||
    isLocalModelLeanEnabled({
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    })
  );
}

export function resolveAgentToolSearchRuntimeConfig(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  model?: { toolSearchMode?: "tools" | false };
  completionPrivateMessageOnly?: boolean;
}): OpenClawConfig | undefined {
  // Select before overlay cloning; cloning source config first loses snapshot identity and can
  // reintroduce unresolved SecretRefs into plugin tool factories.
  const runtimeConfig = resolveAgentRuntimeToolConfig(params.config);
  if (params.completionPrivateMessageOnly) {
    return runtimeConfig;
  }
  if (
    !runtimeConfig ||
    isToolSearchConfigExplicit(runtimeConfig) ||
    !shouldUseLocalToolSearchAuto({ ...params, config: runtimeConfig })
  ) {
    return runtimeConfig;
  }
  return {
    ...runtimeConfig,
    tools: {
      ...runtimeConfig.tools,
      toolSearch: { ...LOCAL_AUTO_TOOL_SEARCH_OVERLAY },
    },
  };
}

/** Directory overlay for unset configs that pass the large-catalog threshold at compact time. */
export function applyLargeCatalogToolSearchOverlay(
  config: OpenClawConfig | undefined,
): OpenClawConfig | undefined {
  if (!config) {
    return {
      tools: { toolSearch: { ...LARGE_CATALOG_AUTO_TOOL_SEARCH_OVERLAY } },
    } as OpenClawConfig;
  }
  return {
    ...config,
    tools: {
      ...config.tools,
      toolSearch: { ...LARGE_CATALOG_AUTO_TOOL_SEARCH_OVERLAY },
    },
  };
}
