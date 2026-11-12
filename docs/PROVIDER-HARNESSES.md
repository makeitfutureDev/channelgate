# Optional provider harnesses

An organization admin can enable **Codex EU** and **Claude Bedrock** in Settings → Engine &
runtime → Harnesses the gateway may use. They start disabled. Save the toggle, then authenticate
on the computer/VPS running ChannelGate, in a terminal as the **gateway service user**. Each
setup card displays the actual directory and command for that deployment. After authentication,
select the harness as a default or approve it for a channel and use `/model` in a new thread.
The options share the installed CLIs and preserve gateway confinement, tools and connector rules.

## Codex EU

The dedicated login is `<gateway runtime root>/engine-state/codex-eu-login`. Run the exact
`CODEX_HOME=... codex ... login --device-auth` command displayed in Settings. The command selects
file credential storage so the service can read the intended login. Choose the ChatGPT Enterprise
workspace with the required EU controls, then verify status under the **same** `CODEX_HOME`.
The normal gateway Codex login and any channel-specific Codex login remain separate.

Container turns require the egress proxy. Legacy bridge-only containers cannot use this
dedicated login; no Enterprise refresh-token file is mounted into those containers.

Codex follows the selected Enterprise workspace's retention and residency settings. The harness
label and isolated directory do not configure or prove EU data or inference residency. Confirm
those controls with your workspace administrator. See [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth).

## Claude Bedrock

The isolated configuration is `<gateway runtime root>/engine-state/claude-bedrock`. Run the
displayed `CLAUDE_CONFIG_DIR=... claude` command, type `/setup-bedrock` and choose **Amazon
Bedrock API key**. Select the AWS region and pin the models your account can invoke. Claude's
wizard writes these values to that directory's `settings.json` `env` block.

This integration accepts `AWS_BEARER_TOKEN_BEDROCK` and `AWS_REGION` (or `AWS_DEFAULT_REGION`)
from that file. It imports only reviewed provider values and model pins, ignoring arbitrary
settings, hooks, permissions, MCPs and credential commands. The proxy receives the real API key
only at the configured standard regional `bedrock-runtime.<region>.amazonaws.com` endpoint;
proxy containers receive a placeholder. Custom endpoints, AWS profiles, SSO and IAM SigV4
access keys are unsupported and produce a setup error. Use an AWS region supported by Bedrock
and ensure the selected Claude models are enabled for your AWS account.

Choose the required Bedrock inference profile deliberately: `eu.` and `global.` model profiles
have different routing scopes. A region setting alone does not constrain a global inference
profile. [Claude Code's Bedrock setup documentation](https://code.claude.com/docs/en/amazon-bedrock)
describes account prerequisites, API keys, model pins and inference profiles.

Neither harness automatically fails over to a different account/provider. Terminal credential
changes take effect on subsequent cold turns. Bedrock token usage is recorded without an invented
AWS dollar cost. Complete the live checks in `TEST-PLAN.md` after configuring the new accounts.

Chat continuation resumes each provider's own session. Bedrock container terminal takeover is
currently unavailable; its Resume Session command explains this instead of opening the session
under the default Anthropic account. Use the same chat thread to continue it. Terminal setup on
the gateway host remains available independently.
