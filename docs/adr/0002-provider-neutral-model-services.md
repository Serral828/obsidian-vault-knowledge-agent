# Connect directly to provider-neutral model services

The Knowledge Agent will own retrieval, tools, safety, and conversation orchestration itself and connect directly to model-generation APIs. The first implementation will support local and cloud OpenAI-compatible endpoints behind the same boundary, defaulting to local use; it will not depend on Codex, Claude Code, or another agent runtime.
