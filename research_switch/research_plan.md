# Research plan: what to steal before switching ML Copilot's core to OpenCode

Main question: which open-source projects, protocols, and techniques should we
fork, reuse, or copy ideas from when (a) swapping the agent core from Pi to
OpenCode, and (b) hardening execution (sandboxing, permissions) for a local
ML-coding agent?

Subtopics (one agent each, 3-5 searches max, concise findings with URLs):
1. harnesses — OpenHands, SWE-agent, Aider, Cline/Roo, Continue, SmolAgents:
   architecture ideas + reusably-licensed code for permissions, sessions,
   compacting, tool loops.
2. acp — Agent Client Protocol: spec status, who implements it, TS client
   libraries we could reuse for our ACP integration.
3. sandbox — lightweight local sandboxing for coding agents on Linux
   (bubblewrap, nsjail, rootless Docker/podman, gVisor, Daytona, E2B, Vercel
   Sandbox, Modal): what fits an Electron app spawning agents locally.
4. ml-prior-art — MCP servers for ML/training/GPU/experiment tracking;
   DeepSeek open-source agent tooling; ML-agent harnesses (MLE-bench,
   terminal-bench): what exists for run control, GPU query, eval design.

Synthesis: reusable-code shortlist + protocol choice + sandbox recommendation,
then chat with the user before implementation.
