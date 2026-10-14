export const EXEC_AUTO_REVIEW_GUIDANCE =
  "An automatic reviewer may deny a command and explain why; if denied, choose a materially safer alternative or ask the user, never work around the denial.";

/** Builds the model-facing exec tool description for the current platform and capabilities. */
export function describeExecTool(params?: {
  hasCronTool?: boolean;
  hasProcessTool?: boolean;
  autoReview?: boolean;
}): string {
  const continuation =
    params?.hasProcessTool === false
      ? ["Run shell and wait for completion."]
      : [
          "Run shell now; background continuation supported.",
          "Completed calls return output. Use process only when exec reports running with a sessionId.",
          "Long run: auto-wake when enabled on output/failure; else process confirms completion.",
        ];
  const base = [
    ...continuation,
    params?.hasCronTool ? "No sleep loops for reminders/follow-ups; use automations." : undefined,
    "TTY CLI/UI/coding agent: pty=true.",
  ]
    .filter(Boolean)
    .join(" ");
  const description =
    process.platform !== "win32"
      ? `${base} Quote args with shell metacharacters, including URL query \`?\`/\`&\`.`
      : `${base}\nIMPORTANT (Windows): Run executables directly; do NOT wrap in \`cmd /c\`, \`powershell -Command\`, \`& \` prefix, or WSL. Use backslash paths (C:\\path). Prefer short names (\`node\`, \`python3\`) over full paths.`;
  return params?.autoReview ? `${description} ${EXEC_AUTO_REVIEW_GUIDANCE}` : description;
}

/** Builds the model-facing process-control tool description. */
export function describeProcessTool(params?: { hasCronTool?: boolean }): string {
  return [
    "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill.",
    "poll/log: status/output/input hints. Others: input/intervention.",
    params?.hasCronTool
      ? "No polling as timer/reminder; scheduled follow-up uses automations."
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}
