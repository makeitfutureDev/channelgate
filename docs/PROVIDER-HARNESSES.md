# Optional provider harnesses

An organization admin can enable **Codex EU** and **Claude Extra** in Settings → Engine &
runtime → Harnesses the gateway may use. They start disabled. Save the toggle, then authenticate
on the computer/VPS running ChannelGate, in a terminal as the **gateway service user**. Each
setup card displays the actual directory and command for that deployment. After authentication,
select the harness as a default or approve it for a channel and use `/model` in a new thread.
The options share the installed CLIs and preserve gateway confinement, tools and connector rules.

## Codex EU

The dedicated login is `<gateway runtime root>/engine-state/codex-eu-login`. Run the exact
`CODEX_HOME=... codex ... login --device-auth` command displayed in Settings. The command selects
file credential storage so the service can read the intended login. Choose the intended ChatGPT
workspace, including Pro Lite; an Enterprise subscription is not required. Verify status under
the **same** `CODEX_HOME`.
The normal gateway Codex login and any channel-specific Codex login remain separate.

Container turns require the egress proxy. Legacy bridge-only containers cannot use this
dedicated login; no real refresh-token file is mounted into those containers.

Codex follows the selected workspace's available retention and residency controls. The harness
label and isolated directory do not configure or prove EU data or inference residency. Confirm
those controls with your workspace administrator. See [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth).

## Claude Extra

Claude Extra is another instance of the same Claude Code CLI. It accepts a separate Claude
subscription login or an Amazon Bedrock setup. The internal engine ID remains `claude-bedrock`
for compatibility. Its isolated configuration remains
`<gateway runtime root>/engine-state/claude-bedrock`, preserving existing logins and sessions.

Run the displayed `CLAUDE_CONFIG_DIR=... claude` command as the gateway service user. For a
subscription, sign in normally to the intended Claude account and exit after login completes.
Verify authentication using the **same** `CLAUDE_CONFIG_DIR`. A login made in the operator's
regular `~/.claude` belongs to the regular Claude harness, not Claude Extra.

When no AWS/Bedrock setup is configured in the isolated directory, Claude Extra uses only its
own OAuth login. It never substitutes the regular Claude account, a setup-token from gateway
settings or an ambient Anthropic API key. Missing, expired or removed dedicated credentials
produce a login error. The container receives a distinct destination-bound access-token
placeholder, never the OAuth refresh token. Refresh stays in the original host login directory;
credentials are not copied or moved to a second refresh chain. Normal Claude remains independent.
The subscription keeps its own usage limits and routes to Anthropic; it does not establish AWS
or EU data/inference residency.

### Amazon Bedrock setup

For AWS, run the same isolated terminal command, type `/setup-bedrock` and choose **Amazon
Bedrock API key**. Select the AWS region and pin the models your account can invoke. Claude's
wizard writes these values to that directory's `settings.json` `env` block. An AWS/Bedrock
configuration selects Bedrock even if an OAuth login also exists; incomplete or malformed AWS
setup fails clearly rather than falling back to that subscription.

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

### Models and continuation

The `opus`, `sonnet` and `haiku` model aliases work in either mode. Native Claude model IDs
belong to subscription mode; AWS model IDs and inference-profile ARNs belong to Bedrock mode.
Choose defaults that match the configured provider when changing terminal authentication.

Neither optional harness automatically fails over to a different account/provider. Terminal
credential changes take effect on subsequent cold turns. Bedrock token usage is recorded
without an invented AWS dollar cost. Complete the live checks in `TEST-PLAN.md` after configuring
the new accounts; unit fixtures do not certify live credentials or provider availability.

Chat continuation resumes each harness's own session. Claude Extra container terminal takeover
is currently unavailable; its Resume Session command explains this instead of opening the
session under the default Anthropic account. Use the same chat thread to continue it. Terminal
setup on the gateway host remains available independently.
