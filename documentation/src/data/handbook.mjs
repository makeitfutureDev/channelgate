import { controlPages } from './control-reference.mjs';

export const featureGroups = [
  {
    "label": "Working together",
    "description": "Start, steer, continue, and coordinate agent work in a conversation.",
    "items": [
      {
        "slug": "conversations",
        "label": "Conversations",
        "description": "Channels, direct messages, membership, and the first agent turn."
      },
      {
        "slug": "invocation-and-reactions",
        "label": "Start work from messages and reactions",
        "description": "Invoke the agent in DMs, channels, existing threads, or with an engagement reaction."
      },
      {
        "slug": "threads-and-sessions",
        "label": "Threads and sessions",
        "description": "Continue a task with its own history and engine session."
      },
      {
        "slug": "conversation-forks",
        "label": "Branch a conversation",
        "description": "Fork a completed Claude or Codex session into a new Slack thread."
      },
      {
        "slug": "collaboration-and-steering",
        "label": "Steer, queue, and stop",
        "description": "Guide active work and manage overlapping requests."
      },
      {
        "slug": "interactive-questions",
        "label": "Interactive questions",
        "description": "Answer clarification questions using forms and choice cards."
      },
      {
        "slug": "progress-and-streaming",
        "label": "Live progress and streamed answers",
        "description": "Follow stages, tools, thinking activity, and agent work while an answer is being prepared."
      },
      {
        "slug": "session-recovery",
        "label": "Resume and recovery",
        "description": "Continue stopped or interrupted work and adopt local sessions."
      },
      {
        "slug": "context-and-compaction",
        "label": "Context and compaction",
        "description": "Inspect context usage, compact an eligible Claude session, or deliberately start fresh."
      },
      {
        "slug": "chat-commands",
        "label": "Chat commands",
        "description": "Control sessions, models, status, and repeating work."
      },
      {
        "slug": "shared-workspaces",
        "label": "Shared workspaces",
        "description": "Work with files and repositories shared by a conversation."
      },
      {
        "slug": "shared-folder-conflicts",
        "label": "Shared folders and concurrent edits",
        "description": "Prevent overlapping work from overwriting files or conflicting with managed skills and memory."
      }
    ]
  },
  {
    "label": "Files and reports",
    "description": "Work with files, recordings, shared documents, and native Slack reports.",
    "items": [
      {
        "slug": "files-and-editor",
        "label": "Files and editor",
        "description": "Browse, edit, and upload files from your chat."
      },
      {
        "slug": "attachments-and-voice",
        "label": "Attachments and voice",
        "description": "Bring documents, images, recordings, and voice messages into work."
      },
      {
        "slug": "image-understanding",
        "label": "Images and screenshots",
        "description": "Give the agent visual evidence and receive generated image previews in Slack."
      },
      {
        "slug": "voice-prompts",
        "label": "Voice prompts",
        "description": "Turn a Slack voice clip into text instructions with local transcription or Slack’s completed transcript."
      },
      {
        "slug": "video-understanding",
        "label": "Video and screen-recording analysis",
        "description": "Combine sampled frames and timestamped speech to understand a recorded workflow."
      },
      {
        "slug": "file-sharing",
        "label": "Share and export files",
        "description": "Deliver artifacts in chat or hand them to connected services."
      },
      {
        "slug": "public-file-links",
        "label": "Temporary public file links",
        "description": "Give a file a limited download URL for a person or a service that ingests files by URL."
      },
      {
        "slug": "report-artifacts",
        "label": "Tables, charts, and canvases",
        "description": "Create rich reports, structured lists, and shared documents in Slack."
      },
      {
        "slug": "slack-tables",
        "label": "Slack data tables and spreadsheet exports",
        "description": "Present sortable read-only results or export larger datasets as CSV and TSV."
      },
      {
        "slug": "slack-charts",
        "label": "Native Slack charts",
        "description": "Show a trend or comparison with an inline line, bar, area, or pie chart."
      },
      {
        "slug": "slack-lists",
        "label": "Editable Slack Lists",
        "description": "Create a shared tracker, inspect its columns, and add or update records."
      },
      {
        "slug": "slack-canvases",
        "label": "Slack canvases",
        "description": "Create and maintain shared notes and runbooks through a connected Slack account."
      },
      {
        "slug": "slack-history",
        "label": "Read Slack history and earlier attachments",
        "description": "Catch up on the current conversation, inspect a thread, and retrieve a previously shared file."
      }
    ]
  },
  {
    "label": "Agents and models",
    "description": "Choose an engine, account, model, and a team of agents.",
    "items": [
      {
        "slug": "claude-code",
        "label": "Claude Code",
        "description": "Connect a Claude login and use the primary agent engine."
      },
      {
        "slug": "codex",
        "label": "OpenAI Codex",
        "description": "Use Codex with the shared login or a dedicated channel account."
      },
      {
        "slug": "dedicated-codex-login",
        "label": "A dedicated Codex login for a conversation",
        "description": "Select a separate Codex account without falling back to another conversation or gateway login."
      },
      {
        "slug": "qwen",
        "label": "Qwen providers",
        "description": "Configure an opt-in compatible provider through the Claude harness."
      },
      {
        "slug": "opencode",
        "label": "OpenCode proof adapter",
        "description": "Use the restricted third engine only for admitted read-only, network-off work."
      },
      {
        "slug": "subagents",
        "label": "Agent teams and in-turn delegation",
        "description": "Split a substantial task into bounded agent scopes and collect their results within the turn."
      },
      {
        "slug": "models-and-effort",
        "label": "Models and effort",
        "description": "Set defaults or pin a model for one thread."
      },
      {
        "slug": "model-picker",
        "label": "The model and effort picker",
        "description": "Choose the scope, engine, model, and effort from the Slack wizard."
      },
      {
        "slug": "multi-engine-failover",
        "label": "Engine failover",
        "description": "Understand fallback behavior and explicit engine pins."
      },
      {
        "slug": "authentication-health",
        "label": "Authentication health",
        "description": "Inspect the resolved engine login and receive bounded alerts when Claude authentication needs repair.",
        "sources": [
          "src/gateway/login-watch.js",
          "src/gateway/claude-login.js",
          "src/engines/engine-health.js"
        ]
      }
    ]
  },
  {
    "label": "Memory and instructions",
    "description": "Keep durable knowledge and give agents clear working rules.",
    "items": [
      {
        "slug": "memory",
        "label": "Persistent memory",
        "description": "Keep channel knowledge available across threads and sessions."
      },
      {
        "slug": "channel-instructions",
        "label": "Channel instructions",
        "description": "Give a workspace standing context and working rules."
      },
      {
        "slug": "gateway-operating-guide",
        "label": "Customizing the gateway operating guide",
        "description": "Keep common agent behavior consistent across every conversation."
      }
    ]
  },
  {
    "label": "Skills and library",
    "description": "Discover, author, govern, synchronize, and share reusable workflows.",
    "items": [
      {
        "slug": "skills",
        "label": "Skills",
        "description": "Discover, grant, and maintain reusable instructions."
      },
      {
        "slug": "skill-discovery",
        "label": "Finding and inspecting skills",
        "description": "Search the governed catalog and inspect a package before granting it."
      },
      {
        "slug": "skill-grants",
        "label": "Skill grants and dependencies",
        "description": "Choose workflows for a person, conversation, or organization."
      },
      {
        "slug": "skill-templates",
        "label": "Skill templates",
        "description": "Follow a centrally maintained workflow set while keeping local additions."
      },
      {
        "slug": "skill-authoring",
        "label": "Creating and updating skills",
        "description": "Turn a repeatable procedure into a versioned workflow package."
      },
      {
        "slug": "skill-reviews",
        "label": "Skill review, history, and rollback",
        "description": "Approve proposals and source revisions while preserving a known working version."
      },
      {
        "slug": "skill-governance",
        "label": "Skill governance and scope",
        "description": "Control enabled, discoverable, mandatory, and channel-specific packages."
      },
      {
        "slug": "skill-synchronization",
        "label": "Skill sources and synchronization",
        "description": "Import workflows from Git repositories, host folders, or peer gateways."
      },
      {
        "slug": "skill-publishing",
        "label": "Publishing skills to Git",
        "description": "Persist authored and approved workflows in a configured repository."
      },
      {
        "slug": "skill-usage",
        "label": "Skill usage and context cost",
        "description": "See which workflows are used and keep the active profile focused."
      },
      {
        "slug": "plugins",
        "label": "Plugins",
        "description": "Use packaged skills and explicitly connected tools."
      },
      {
        "slug": "skills-library-mcp",
        "label": "Skills library for external assistants",
        "description": "Expose the governed catalog to laptops and peer gateways through a scoped MCP endpoint."
      },
      {
        "slug": "business-workflows",
        "label": "Business workflow examples",
        "description": "Combine skills, approved accounts, and review points for repeatable team work."
      }
    ]
  },
  {
    "label": "Connections and integrations",
    "description": "Connect tools, service accounts, and synchronized workspace storage.",
    "items": [
      {
        "slug": "mcp",
        "label": "MCP tools",
        "description": "Choose the external tools an engine can use."
      },
      {
        "slug": "connected-accounts",
        "label": "Connected accounts",
        "description": "Separate personal accounts from shared agent connections."
      },
      {
        "slug": "composio-sdk",
        "label": "Enterprise Composio SDK mode",
        "description": "Provision reusable user and channel app sessions with the Enterprise Beta integration."
      },
      {
        "slug": "toolbox-and-make",
        "label": "Toolbox and Make connections",
        "description": "Use optional credential-backed tool servers without mixing account scopes."
      },
      {
        "slug": "drive-sync",
        "label": "Google Drive sync",
        "description": "Synchronize a conversation workspace with a configured Drive folder."
      }
    ]
  },
  {
    "label": "Security and access",
    "description": "Set admission, tool policy, credential protection, and execution boundaries.",
    "items": [
      {
        "slug": "permissions",
        "label": "Modes and permissions",
        "description": "Read-only, Worker, Admin, Auto, and Lean settings."
      },
      {
        "slug": "lean-context",
        "label": "Lean mode and thread Clean",
        "description": "Run with a reduced prompt by omitting optional connectors, skills, and injected context."
      },
      {
        "slug": "access-templates",
        "label": "Access templates",
        "description": "Apply a starting policy to new conversations."
      },
      {
        "slug": "approvals",
        "label": "Approvals",
        "description": "Review tool requests and understand decision scopes."
      },
      {
        "slug": "secrets",
        "label": "Variables and secrets",
        "description": "Provide credentials without pasting them into a prompt."
      },
      {
        "slug": "network-access",
        "label": "Network access",
        "description": "Manage outbound connectivity and secret destination approvals."
      },
      {
        "slug": "container-isolation",
        "label": "Container isolation",
        "description": "Understand the default per-conversation runtime boundary."
      },
      {
        "slug": "sudo-threads",
        "label": "Direct-host sudo threads",
        "description": "Give an admin thread explicit host execution access."
      }
    ]
  },
  {
    "label": "Developer tools",
    "description": "Attach to the workspace and use its browser and development toolchain.",
    "items": [
      {
        "slug": "ssh-access",
        "label": "SSH access",
        "description": "Open an authorized developer connection to a workspace container."
      },
      {
        "slug": "vscode-access",
        "label": "VS Code and interactive CLI access",
        "description": "Open the actual conversation container with VS Code or a terminal and continue development there."
      },
      {
        "slug": "workspace-toolchain",
        "label": "The workspace toolchain",
        "description": "Use the pinned development and media tools installed in every conversation image."
      },
      {
        "slug": "browser-automation",
        "label": "Browser automation",
        "description": "Open websites, inspect interactive pages, fill authorized forms, and collect screenshots."
      }
    ]
  },
  {
    "label": "Chat platforms",
    "description": "Connect each surface and use its application and settings controls.",
    "items": [
      {
        "slug": "slack",
        "label": "Slack",
        "description": "Set up the app and work with native chat controls."
      },
      {
        "slug": "slack-app-home",
        "label": "Slack App Home",
        "description": "Check your gateway role, personal connections, skills, and visible conversations."
      },
      {
        "slug": "slack-settings",
        "label": "The Slack settings console",
        "description": "Use the reply menu to manage runtime, variables, tools, skills, automation, and session handoff."
      },
      {
        "slug": "microsoft-teams",
        "label": "Microsoft Teams · Beta",
        "description": "Connect a Teams bot and understand current surface limits."
      },
      {
        "slug": "google-chat",
        "label": "Google Chat · Beta",
        "description": "Connect Google Chat through authenticated Pub/Sub intake."
      }
    ]
  },
  {
    "label": "Automation",
    "description": "Run scheduled, conditional, repeated, or externally triggered work.",
    "items": [
      {
        "slug": "schedules",
        "label": "Schedules and loops",
        "description": "Set up recurring and one-time work with predictable delivery."
      },
      {
        "slug": "loops",
        "label": "Repeating agent loops",
        "description": "Pace repeated work in the same thread with an explicit tick budget."
      },
      {
        "slug": "background-jobs",
        "label": "Background work",
        "description": "Run longer jobs and receive their results in the thread."
      },
      {
        "slug": "reminders-and-acknowledgments",
        "label": "Reminders and acknowledgments",
        "description": "Post reminders without an agent run, and follow up until someone acknowledges them.",
        "sources": [
          "src/config/acks.js",
          "src/mcp/tools/schedules.js",
          "src/gateway/scheduler.js"
        ]
      },
      {
        "slug": "followup-digests",
        "label": "Follow-up digests",
        "description": "Receive a personal digest of agent conversations that are waiting for your response.",
        "sources": [
          "src/gateway/followups.js",
          "src/config/settings.js",
          "src/slack/app.js"
        ]
      },
      {
        "slug": "quiet-thread-nudges",
        "label": "Quiet-thread nudges",
        "description": "Opt in to one gentle reminder when an agent thread goes unanswered.",
        "sources": [
          "src/gateway/nudges.js",
          "src/config/settings.js",
          "src/web/routes/users.js"
        ]
      },
      {
        "slug": "conditional-monitoring",
        "label": "Conditional monitoring",
        "description": "Check on a schedule and notify the creator only when a result matches a chosen prefix.",
        "sources": [
          "src/mcp/tools/schedules.js",
          "src/gateway/scheduler.js",
          "src/config/schedules.js"
        ]
      },
      {
        "slug": "automation-delivery",
        "label": "Automation delivery",
        "description": "Choose threaded results, daily threads, direct channel posts, or private matching alerts.",
        "sources": [
          "src/gateway/scheduler.js",
          "src/mcp/tools/schedules.js",
          "src/platforms/notify.js"
        ]
      },
      {
        "slug": "trusted-bot-triggers",
        "label": "Trusted bot triggers",
        "description": "Allow selected Slack integration messages to start runs without accepting every bot message.",
        "sources": [
          "src/config/settings.js",
          "src/slack/message-pipeline.js",
          "public/index.html"
        ]
      },
      {
        "slug": "run-api",
        "label": "HTTP run API",
        "description": "Trigger agent work from an external application."
      }
    ]
  },
  {
    "label": "Administration and visibility",
    "description": "Manage users and conversations, inspect active work, and track health and usage.",
    "items": [
      {
        "slug": "admin-dashboard",
        "label": "Admin dashboard",
        "description": "Find settings, conversations, users, and operational controls."
      },
      {
        "slug": "conversation-administration",
        "label": "Conversation administration",
        "description": "Manage conversation details, inherited defaults, runtime choices, and bulk resets.",
        "sources": [
          "src/web/routes/channels.js",
          "public/admin-state.js",
          "public/admin-routes.js"
        ]
      },
      {
        "slug": "user-administration",
        "label": "User administration",
        "description": "Approve people, assign administrator roles, manage preferences, and inspect masked account configuration.",
        "sources": [
          "src/web/routes/users.js",
          "public/index.html",
          "src/gateway/modes.js"
        ]
      },
      {
        "slug": "settings-search-and-conflicts",
        "label": "Settings search and conflicts",
        "description": "Find settings quickly and handle concurrent edits without overwriting unrelated changes.",
        "sources": [
          "public/admin-settings-search.js",
          "public/admin-state.js",
          "src/web/routes/settings.js",
          "src/web/routes/channels.js"
        ]
      },
      {
        "slug": "live-sessions",
        "label": "Live sessions",
        "description": "See which conversations, people, engines, and models are running right now.",
        "sources": [
          "public/app.js",
          "src/web/routes/observability.js",
          "src/gateway/active-runs.js"
        ]
      },
      {
        "slug": "activity-and-audit",
        "label": "Activity and audit",
        "description": "Inspect run history separately from configuration and security events.",
        "sources": [
          "src/web/routes/observability.js",
          "src/config/channel-audit.js",
          "public/admin-events.js"
        ]
      },
      {
        "slug": "usage-and-costs",
        "label": "Usage and costs",
        "description": "Inspect agent activity and attributed model costs."
      },
      {
        "slug": "pricing-and-usage-repair",
        "label": "Pricing and usage repair",
        "description": "Preview accounting repairs, preserve raw evidence, and audit API-equivalent cost estimates.",
        "sources": [
          "src/gateway/usage-repair.js",
          "src/gateway/usage-pricing.js",
          "src/gateway/external-usage.js",
          "scripts/repair-codex-usage-history.mjs",
          "scripts/refresh-codex-pricing.mjs"
        ]
      },
      {
        "slug": "system-health",
        "label": "System health",
        "description": "Watch CPU, memory, storage, and capacity history."
      }
    ]
  },
  {
    "label": "Operating ChannelGate",
    "description": "Install, maintain, recover, license, and extend your deployment.",
    "items": [
      {
        "slug": "runtime-lifecycle",
        "label": "Runtime lifecycle",
        "description": "Understand container reuse, idle stops, persistent volumes, and safe recreation.",
        "sources": [
          "src/runtimes/container/lifecycle.js",
          "src/runtimes/container/reaper.js",
          "src/config/settings.js"
        ]
      },
      {
        "slug": "resource-limits",
        "label": "Resource limits",
        "description": "Set container capacity and run concurrency, and distinguish quiet reports from stalled turns.",
        "sources": [
          "src/config/settings.js",
          "src/gateway/run.js",
          "src/engines/watchdog.js"
        ]
      },
      {
        "slug": "restart-and-recovery",
        "label": "Restart and recovery",
        "description": "Drain current work safely and understand which interrupted operations can resume.",
        "sources": [
          "src/gateway/restart.js",
          "src/gateway/stopped-turns.js",
          "src/gateway/scheduler.js",
          "src/platforms/durable-inbox.js"
        ]
      },
      {
        "slug": "failure-diagnosis",
        "label": "Failure diagnosis",
        "description": "Open a bounded source investigation for unexpected failures without automatically applying a fix.",
        "sources": [
          "src/gateway/diagnosis.js",
          "src/config/settings.js",
          "src/slack/message-pipeline.js"
        ]
      },
      {
        "slug": "health-endpoints",
        "label": "Health endpoints",
        "description": "Monitor daemon liveness without exposing authenticated engine and host details.",
        "sources": [
          "src/web/app.js",
          "src/web/auth.js",
          "src/server.js"
        ]
      },
      {
        "slug": "updates",
        "label": "Updates",
        "description": "Keep the daemon and runtime image current."
      },
      {
        "slug": "backup-and-restore",
        "label": "Backups and restore",
        "description": "Protect configuration and plan for recovery."
      },
      {
        "slug": "storage-maintenance",
        "label": "Storage maintenance",
        "description": "Report reclaimable container storage and maintain runtime backups and logs deliberately.",
        "sources": [
          "scripts/runtime-storage.mjs",
          "src/runtimes/container/storage-report.js",
          "scripts/runtime-maintenance.mjs"
        ]
      },
      {
        "slug": "licensing",
        "label": "Licensing",
        "description": "Choose a tier and activate an organization key."
      },
      {
        "slug": "offline-licensing",
        "label": "Offline licensing",
        "description": "Use a signed license payload and understand unreachable-platform grace behavior.",
        "sources": [
          "src/ee/license.js",
          "src/ee/tiers.js",
          "src/mcp/tools/license.js"
        ]
      },
      {
        "slug": "vpn-database",
        "label": "VPN database access",
        "description": "Use the optional operator-provisioned database tunnel."
      },
      {
        "slug": "operator-commands",
        "label": "Operator commands",
        "description": "Find the supported installation, image, backup, accounting, and maintenance workflows.",
        "sources": [
          "package.json",
          "INSTALL.md",
          "docs/OPERATIONS.md"
        ]
      },
      {
        "slug": "contributing-and-extension",
        "label": "Contributing and extension",
        "description": "Contribute on beta and extend engines or chat platforms through their contracts.",
        "sources": [
          "CONTRIBUTING.md",
          "src/engines/contract.js",
          "src/platforms/contract.js",
          "AGENTS.md"
        ]
      },
      {
        "slug": "website-and-customer-portal",
        "label": "Website and customer portal",
        "description": "Distinguish the public product website and portal from your self-hosted admin interface.",
        "sources": [
          "FEATURES.md: Public website",
          "documentation/README.md",
          "public/admin-routes.js"
        ]
      }
    ]
  }
];
export const configurationPages = [
  {
    "slug": "gateway-settings",
    "label": "Gateway settings",
    "description": "Connections, agent defaults, runtime, and organization settings."
  },
  {
    "slug": "channel-settings",
    "label": "Channel settings",
    "description": "Configure the workspace, access, instructions, tools, and runtime."
  },
  {
    "slug": "access-and-users",
    "label": "Users and access",
    "description": "Approve users, assign administrators, and manage conversation access."
  },
  {
    "slug": "engine-authentication",
    "label": "Engine authentication",
    "description": "Sign in Claude and Codex, including a dedicated channel login."
  },
  {
    "slug": "model-defaults",
    "label": "Model defaults",
    "description": "Resolve gateway, channel, thread, and per-run selections."
  },
  {
    "slug": "connections",
    "label": "Connected accounts",
    "description": "Set up personal and shared service connections."
  },
  {
    "slug": "mcp-servers",
    "label": "MCP configuration",
    "description": "Enable native Cloud MCP tools and explicitly connected plugin servers."
  },
  {
    "slug": "environment-variables",
    "label": "Variables and secrets",
    "description": "Choose a credential scope, visibility, and allowed destinations."
  },
  {
    "slug": "skill-sources",
    "label": "Skills and sources",
    "description": "Add sources, templates, grants, and governance settings."
  },
  {
    "slug": "network-policy",
    "label": "Network policy",
    "description": "Configure network access and credential destination rules."
  },
  {
    "slug": "storage-and-runtime",
    "label": "Storage and runtime",
    "description": "Choose folders and understand containers, mounts, and retention."
  },
  {
    "slug": "notifications-and-automation",
    "label": "Automation settings",
    "description": "Configure schedules, delivery, and background work."
  },
  {
    "slug": "deployment",
    "label": "Deployment settings",
    "description": "Set up the Linux service, reverse proxy, and operational environment."
  }
];
export const featurePages = featureGroups.flatMap((group) => group.items);
export const handbookSlugs = ['features', 'configuration', 'functionality', 'controls', ...controlPages.map((page) => `controls/${page.slug}`), ...featurePages.map((page) => `features/${page.slug}`), ...configurationPages.map((page) => `configuration/${page.slug}`)];
