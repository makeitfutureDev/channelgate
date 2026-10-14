---
title: Engine authentication
description: Configure Claude, Codex, and optional provider credentials without mixing them with app accounts, and choose a login that fits European data handling.
---

An engine login authenticates the model answering a turn. It is independent of Slack credentials, connected business apps, and environment variables used to deploy a project. Enabling an engine does not sign it in.

## Login routes at a glance

| Engine | Login route | Where it is configured |
| --- | --- | --- |
| Claude Code | The operator's `claude` login on the gateway host, backed by a Pro, Max, Team or Enterprise seat | Run `claude` on the host as the daemon's account |
| Claude Code | A long-lived `claude setup-token` value | **Settings → Access & security → Container runtime → Claude token for container runs** |
| Claude Code | An Anthropic API key, for a service install with no interactive login | `ANTHROPIC_API_KEY` in the daemon's environment |
| Codex | **Sign in with ChatGPT**, for the gateway or for one conversation | **Settings → Agent defaults → Engine & runtime → Default gateway Codex login**, or the conversation's **Runtime → Codex authentication** |
| Codex | **Use an OpenAI API key**, billed separately from a ChatGPT plan | The same settings |
| Qwen and Qwen EU | The provider's own API key and endpoint, opt-in | Provider cards under **Agent defaults** |
| OpenCode | An operator-provided CLI and provider setup, admitted read-only and network-off only | Operator setup, see [OpenCode](/docs/features/opencode) |

The plan behind a login sets its cost, usage limits and contract terms. ChannelGate does not bundle provider access, and the [European data handling](#choose-a-login-for-work-in-europe) section below explains which login suits which kind of data.

## Claude Code

For a daemon running as an interactive operator account, sign in with `claude` on the gateway host as that account. The gateway resolves credentials in this order:

1. An explicitly configured **Claude token for container runs**.
2. The operator's usable Claude login.
3. A usable login in the gateway's own engine state.
4. The daemon's Anthropic API credential.

To configure the explicit token, run `claude setup-token` on the host, then paste its result into **Settings → Access & security → Container runtime → Claude token for container runs** and save. Leave an existing secret field untouched to keep its value. Use its clear control when you intentionally want to return to another credential source.

In the default proxy runtime, the gateway relays the resolved login's access credential. The operator's full credential file and refresh token are not copied into an ordinary channel container. A hard-expired login needs an interactive sign-in again; restarting the daemon does not renew the login session.

## OpenAI Codex

Open **Settings → Agent defaults → Engine & runtime → Default gateway Codex login**. Choose **Sign in with ChatGPT** and complete the device flow, or choose **Use an OpenAI API key** and save the key. API-key usage is billed separately from a ChatGPT subscription.

Codex also supports a conversation-specific login. In the conversation's Codex sign-in controls, choose the channel login source and sign in there. Choosing this source locks the conversation and its threads to Codex. A channel-specific source must have its own usable login; it does not silently use someone else's gateway account when missing. The gateway keeps these login records outside the agent-writable workspace.

| Credential choice | Scope |
| --- | --- |
| Gateway Codex login | Conversations selecting the gateway source |
| Channel Codex login | The selected conversation |

## Service installations and optional providers

A dedicated non-login system service needs credentials configured for its service identity. Follow the service credential steps in [Installation](/docs/installation) and [Operations](/docs/operations); signing in as a different Linux user does not necessarily authenticate that service.

Optional Anthropic-compatible provider harnesses have their own API-key and base-URL cards under **Agent defaults**. Configure the intended provider and explicitly enable its harness. These providers do not receive the operator's Anthropic login and do not participate in automatic Claude and Codex failover.

## Choose a login for work in Europe

The engine login decides two things ChannelGate does not control: which provider contract covers the prompts, and where inference runs. Work folders, memory, files and conversation history stay on your host, but every turn sends prompt and context to the selected provider, as described in [privacy and data flow](/docs/privacy). The provider facts below come from the providers' own documentation as of October 2026. Check the current terms before relying on them, and treat this section as orientation for your own assessment rather than legal advice.

:::caution[What this page does and does not cover]
This section lists the login options the providers offer; it is not a recommendation for your situation. The contract for each route, including the data processing addendum, retention, training and residency commitments, is between your organization and the AI provider. Makeitfuture and ChannelGate are not party to it, do not verify the provider's compliance with it, and accept no responsibility for the provider's data handling or for the output and actions of the models. Review the current provider terms with your data protection officer before placing customer data in a conversation, and see the [platform terms](https://channelgate.dev/terms) for the limits of what ChannelGate itself provides.
:::

### Internal work without customer data

A personal Claude Pro or Max login, or a personal ChatGPT Plus or Pro sign-in for Codex, runs under consumer terms. Consumer plans carry no data processing agreement under GDPR Article 28, and [Anthropic's consumer terms for the EEA, Switzerland and the UK](https://www.anthropic.com/legal/consumer-terms) limit the service to non-commercial use. OpenAI's consumer plans also come without a DPA. Use such a login for evaluation and for internal material that contains no customer personal data, and switch off the plan's training setting where one exists.

### Customer data under a processor contract

Each route below places the prompts under a commercial contract with a data processing addendum. They differ in where inference runs. Routes marked as in development are being added to ChannelGate; the provider facts for them hold today.

| Login route | Contract and training | Where inference runs | In ChannelGate |
| --- | --- | --- | --- |
| Claude Team or Enterprise seat, signed in with `claude` or a `claude setup-token` value | [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms) with the Data Processing Addendum incorporated; Anthropic may not train models on Customer Content | Anthropic documents only `global` and `us` inference and US-only storage, with [no EU option](https://platform.claude.com/docs/en/manage-claude/data-residency) on any first-party plan | Available. Claude Code is included in [Team and Enterprise seats](https://claude.com/pricing). |
| Anthropic API key | The same Commercial Terms and addendum | The same geography | Available for service installs. |
| ChatGPT Enterprise sign-in for Codex | OpenAI business terms with a DPA, and [no training by default](https://openai.com/business-data/) | Eligible Enterprise workspaces can choose European data residency and [in-region inference](https://help.openai.com/en/articles/9903489-data-residency-and-inference-residency-for-chatgpt) | Available. Confirm with OpenAI that Codex CLI traffic from your workspace is within the scope of that residency setting. |
| ChatGPT Business sign-in for Codex | The same DPA and no-training default; [Codex is included](https://learn.chatgpt.com/docs/pricing) | Regional storage at rest is rolling out to Business workspaces without inference residency | Available, with US processing. |
| OpenAI API key for Codex | OpenAI API terms with a DPA; no training | A Europe-region project processes and stores in region through `eu.api.openai.com`, [after approval for modified abuse monitoring or zero data retention](https://developers.openai.com/api/docs/guides/your-data) | In development. The Codex API-key route currently reaches `api.openai.com`; the European endpoint is being added. |
| Qwen EU harness | Alibaba Cloud contract; a workspace created with the EU deployment scope keeps request data in the [Frankfurt region](https://www.alibabacloud.com/help/en/model-studio/regions) | Germany (Frankfurt), `eu-central-1` | Available and opt-in. The catalog is the region's own (Qwen, Kimi, GLM and DeepSeek families), the provider key reaches the engine raw, and the harness sits outside Claude and Codex failover. See [Qwen harnesses](/docs/features/qwen). |
| Claude through Amazon Bedrock | AWS contract and DPA; AWS states that [inputs and outputs are not used to train models or shared with model providers](https://aws.amazon.com/bedrock/faqs/) | [EU regions](https://code.claude.com/docs/en/amazon-bedrock) such as Frankfurt, Ireland and Paris, with the `eu.` inference profile keeping requests inside the EU geography | In development. The route to Claude in the EU for teams on AWS. |
| Claude through Google Cloud Vertex AI | Google Cloud contract and DPA | [The `eu` multi-region](https://code.claude.com/docs/en/google-vertex-ai), plus [European regions](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations) including Belgium, the Netherlands, Frankfurt, Paris and Zurich | In development. The route to Claude in the EU for teams on Google Cloud. |

In short: a Claude Team or Enterprise login or an Anthropic API key covers customer data under Anthropic's addendum with inference in the US or globally; Claude through Bedrock or Vertex AI, the OpenAI Europe project and the Qwen EU harness are the EU-resident routes; and the Qwen EU harness is the EU-resident route available today, with its own model catalog. The addendum, the training setting and the residency choice belong to your contract with the provider; ChannelGate records usage and enforces access, and it does not change what the provider receives.

## Verify the result

Save, check sign-in/runtime health, and send a simple request from a fresh thread. Login changes are resolved for subsequent runs without copying credentials into project files. Resolve authentication errors before widening tools or changing network policy.

See [Claude Code](/docs/features/claude-code), [Codex](/docs/features/codex), [Qwen](/docs/features/qwen), and [Connections](/docs/configuration/connections).
