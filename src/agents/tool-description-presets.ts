const SECRET_EGRESS_USAGE_PROMPT =
  "Gateway-host commands: use auto-injected opaque env sentinel under stored name. No secret templates; never override/print that variable. Native shell/sandbox/node: no protected injection. First command snapshots store for run; late saves need next turn.";

// Compact built-in summaries shown in tool inventories and model-facing tool
// descriptions when a longer contextual description is assembled elsewhere.
export const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell now.";
export const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect/control exec sessions.";
export const CRON_TOOL_DISPLAY_SUMMARY = "Schedule reminders, automations, wake events.";
export const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY = "List visible sessions; filters/previews.";
export const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY = "Read sanitized session history.";
export const SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY = "Search past session transcripts.";
export const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY = "Run same-Gateway session/agent.";
export const SESSIONS_SEND_RESULT_GUIDANCE =
  'Accepted results report target admission as `targetDisposition: "queued"` or `"steered"`; `delivery.status` is only later announcement state, and neither proves target completion.';
export const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY =
  "Spawn hidden subagent (ephemeral) or visible work session (durable).";
export const SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY = "Spawn subagent session.";
export const AGENTS_WAIT_TOOL_DISPLAY_SUMMARY = "Wait for collector subagents.";
export const SESSION_STATUS_TOOL_DISPLAY_SUMMARY = "Show session status/model/usage.";
export const ASK_USER_TOOL_DISPLAY_SUMMARY = "Ask the user and wait for an answer.";
export const SUGGEST_TASK_TOOL_DISPLAY_SUMMARY = "Suggest follow-up work for operator approval.";
export const DISMISS_TASK_TOOL_DISPLAY_SUMMARY = "Withdraw a pending task suggestion.";
export const SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY =
  "Author reusable skills under the available tool's publication and review policy. Read one complete artifact when it fits the model budget.";

export function describeAgentsListTool(sessionsSpawnAvailable: boolean): string {
  return sessionsSpawnAvailable
    ? 'List configured agent ids with name/model/runtime metadata, allowed as `sessions_spawn(runtime:"subagent")` targets.'
    : "List configured agent ids with name/model/runtime metadata that can be used as subagent spawn targets.";
}

export function describeAgentsWaitTool(sessionsSpawnAvailable: boolean): string {
  const targets = sessionsSpawnAvailable
    ? "collector subagents started by sessions_spawn collect=true"
    : "collector subagent runs";
  return `Wait for ${targets}. Accepts many run ids; returns once any completes (completed results incl. structured output, plus pending ids), or on timeoutSeconds.`;
}

// Mirrors plugin-sdk SessionToolsVisibility; kept local because importing that
// module here would close an agents<->plugin-sdk madge cycle. Call sites pass
// the policy union, so a new mode fails compilation at every consumer.
type SessionVisibilityScope = "self" | "tree" | "agent" | "all";

// Single source for model-facing session-visibility scope wording; every tool
// description or warning that explains visibility renders through this so the
// prose cannot drift from the session-visibility checker (openclaw#114797).
const SESSION_VISIBILITY_SCOPE_COPY = {
  self: "current session only",
  tree: "current session + own spawn subtree; the main session sees all sessions of its agent",
  agent: "all sessions of this agent",
  all: "all sessions, cross-agent per tools.agentToAgent",
} satisfies Record<SessionVisibilityScope, string>;

export function describeSessionVisibilityScope(
  visibility: SessionVisibilityScope,
  options?: { spawnRestricted?: boolean },
): string {
  // Sandboxed sessions under the "spawned" clamp list/read only spawned rows.
  if (options?.spawnRestricted && visibility === "tree") {
    return "current session + own spawn subtree (sandbox: spawned sessions only)";
  }
  return SESSION_VISIBILITY_SCOPE_COPY[visibility];
}

type SessionLinkDescriptionOptions = { sessionLinkBase?: string };

export function describeSessionLinkRule(base: string): string {
  return `When pointing the user at a session, cite its Control UI URL: main session -> \`${base}/chat/<agentId>\`; any other display session key -> \`${base}/chat/<agentId>/~key/\` + key minus \`agent:<agentId>:\`, with \`:\` replaced by \`/\`.`;
}

/** Describes the sessions_list tool for model-facing instructions. */
export function describeSessionsListTool(options?: SessionLinkDescriptionOptions): string {
  return [
    "List visible session metadata/groups; filter ownerId/creatorId, projectId/workspaceDir, group/pinned, kind/agent/activity/archive. relationship=owned|created|involving is the requesting user, not the agent owner.",
    "Metadata-only by default (limit 100; limitApplied≤200). Page with nextOffset while hasMore; live pages need agentId/key/sessionId dedupe. includeLastMessage/messageLimit for previews; enrichmentOmitted => read history separately.",
    "Use before history/send target selection.",
    ...(options?.sessionLinkBase ? [describeSessionLinkRule(options.sessionLinkBase)] : []),
  ].join(" ");
}

/** Describes the sessions_history tool for model-facing instructions. */
export function describeSessionsHistoryTool(options?: SessionLinkDescriptionOptions): string {
  return [
    "Read sanitized visible-session history before reply/debug/resume.",
    "messageId (+ optional sessionId) anchors history (offset ignored); else paginate with offset/limit. includeTools for tool messages. pendingInputs page via pendingBefore=nextBefore; cancelled inputs never auto-replay.",
    ...(options?.sessionLinkBase ? [describeSessionLinkRule(options.sessionLinkBase)] : []),
  ].join(" ");
}

/** Describes the sessions_search tool for model-facing instructions. */
export function describeSessionsSearchTool(options?: SessionLinkDescriptionOptions): string {
  return [
    "Search visible past sessions for matching user and assistant text.",
    ...(options?.sessionLinkBase ? [describeSessionLinkRule(options.sessionLinkBase)] : []),
  ].join(" ");
}

/** Describes the sessions_send tool for model-facing instructions. */
export function describeSessionsSendTool(): string {
  return [
    "Run a visible session by sessionKey/label, or a configured local agent by agentId (sessionKey wins).",
    "Session = model context, not an external address; reply may still announce via delivery context.",
    SESSIONS_SEND_RESULT_GUIDANCE,
    "Omit mode to continue a paused native child (runId/taskRunId + task-owned completion). mode:notify queues next-turn context without waking; mode:steer guides an active run; mode:followup starts a separate turn; mode:resume needs a paused native child (no watch/timeoutSeconds).",
    'Thread chats rejected: target parent. Waits for reply when available; "no_reply" is terminal. watch:true notices later target changes.',
  ].join(" ");
}

export function describeSubagentSpawnContext(threadAvailable: boolean): string {
  return [
    'Native: explicit context="isolated" starts clean; context="fork" copies requester transcript and requires the same agent.',
    threadAvailable
      ? "Omitted context follows configured threadBindings.defaultSpawnContext policy (fork by default) with thread=true; without a thread it is isolated."
      : "Omitted context is isolated.",
  ].join(" ");
}

export const SESSIONS_SPAWN_COLLECTOR_GUIDANCE =
  "Default to ordinary spawn for one or a few children. Reserve `collect=true` (swarm) for large parallel fan-out (several similar children, about five or more). Collectors send no completion notification and cannot be steered; explicitly collect their results; structured result per `outputSchema`; `groupId` groups a batch.";

/** Describes the sessions_spawn tool for model-facing instructions. */
export function describeSessionsSpawnTool(options?: {
  acpAvailable?: boolean;
  threadAvailable?: boolean;
  subagentThreadAvailable?: boolean;
  swarmEnabled?: boolean;
  sessionToolsVisibility?: SessionVisibilityScope;
  spawnRestricted?: boolean;
}): string {
  // Callers that resolve the effective visibility get it rendered as fact;
  // without it the copy must keep the "default" hedge instead of asserting the effective scope.
  const visibilityLine = options?.sessionToolsVisibility
    ? `Session listing/addressing obeys \`tools.sessions.visibility\` (${options.sessionToolsVisibility}: ${describeSessionVisibilityScope(options.sessionToolsVisibility, { spawnRestricted: options.spawnRestricted })}).`
    : `Session listing/addressing obeys \`tools.sessions.visibility\` (\`all\` default: ${describeSessionVisibilityScope("all")}).`;
  const runtimeDescription =
    options?.acpAvailable === false
      ? 'Spawn child session; default `runtime="subagent"`.'
      : 'Spawn child session; default `runtime="subagent"`; ACP needs explicit `runtime="acp"`.';
  return [
    runtimeDescription,
    options?.threadAvailable
      ? '`mode="run"` one-shot; `mode="session"` persistent/thread-bound only on supporting requester channel.'
      : '`mode="run"` one-shot background.',
    "`agentId` targets a configured agent; `model` overrides; `cleanup` delete|keep; `sandbox` inherit|require.",
    "Default hidden subagent for internal work; report through the parent. `visible=true` only when the user wants a separate steerable session (sidebar/group/projectId|projectGitUrl/worktree; inherits tool-policy ceiling).",
    "`placement` = cloud profile (+ optional os/machineClass); requires visible+worktree; never falls back locally on cloud failure.",
    visibilityLine,
    ...(options?.swarmEnabled ? [SESSIONS_SPAWN_COLLECTOR_GUIDANCE] : []),
    "Inherits parent workspace; task arrives as `[Subagent Task]`.",
    ...(options?.acpAvailable === false
      ? []
      : ['`runtime="acp"` ids: codex, claude, gemini, opencode, or configured ACP.']),
    describeSubagentSpawnContext(options?.subagentThreadAvailable === true),
    "No spawn for quick lookup/single read. After spawn, do non-overlap work; follow the receipt's completion mode. A subagent request is not a separate session.",
  ].join(" ");
}

/** Describes the session_status tool for model-facing instructions. */
export function describeSessionStatusTool(): string {
  return [
    "Show visible-session model/usage/time/cost/tasks.",
    '`sessionKey="current"` for current; UI labels are not keys.',
    "`model` overrides; `model=default` resets. Use for active model/session questions.",
  ].join(" ");
}

/** Describes the ask_user tool and its decision-only use policy. */
export function describeAskUserTool(): string {
  return [
    "Ask 1-3 structured questions and wait; `multiSelect` / `timeoutSeconds` optional. Only when blocked on a user decision that defaults/code cannot resolve; never ask to proceed or confirm a plan.",
    "One question per call unless answers must ship together. Put every choice in `options` (recommended first, label suffix ` (Recommended)`). No Other option; free text is automatic. no_answer => continue with best judgment.",
  ].join(" ");
}

/** Describes the secrets tool and the store semantics the model cannot observe. */
export function describeSecretsTool(): string {
  return [
    "Protected credentials: `list` metadata first; `request` missing task-needed name + reason via human masked entry; `delete` removes an entry.",
    "Request waits for human; value goes straight to shared store, never model/chat. Use the returned store SecretRef for supported config fields.",
    "Gateway egress only: enabled proxy + exact allowedHosts required; no hosts blocks egress, not config refs. No plaintext fallback.",
    SECRET_EGRESS_USAGE_PROMPT,
    "Operator-set env entries are readable and managed separately from this protected store. no_answer means no credential was supplied.",
  ].join(" ");
}
