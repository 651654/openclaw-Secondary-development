Pre-compile snapshot for heartbeat-local + utilityModel-cloud mode.

- Heartbeat agent turns use llama-cpp/qwen25-7b-q4 (local Vulkan service on demand).
- Utility paths (progress narrator, activity recap) use deepseek/deepseek-v4-flash.
- Source tweaks bound utility prompt/note sizes so cloud utility stays cheap and local
  heartbeat context pressure is less likely to pull oversized utility payloads.

Operator config is applied under ~/.openclaw/openclaw.json (not in this repo).
