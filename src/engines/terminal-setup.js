// Public, credential-free terminal instructions for optional provider harnesses. Paths resolve
// on the daemon host, where the operator logs in; none of these homes is mounted into a channel.
import { codexEuLoginHome } from "./codex-eu.js";
import { bedrockLoginHome } from "./bedrock.js";

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

export function terminalHarnessSetup() {
  return [
    {
      id: "codex-eu", label: "Codex EU", modelField: "defaultCodexEuModel", effortField: "defaultCodexEuEffort",
      directory: codexEuLoginHome(),
      command: `install -d -m 700 ${shellQuote(codexEuLoginHome())} && CODEX_HOME=${shellQuote(codexEuLoginHome())} codex -c cli_auth_credentials_store='"file"' login --device-auth`,
      description: "Sign in on the gateway host as the gateway service user, choosing your ChatGPT Enterprise workspace. Configure EU data and inference residency in that workspace. A separate login alone does not enforce residency. This harness never falls back to another account.",
    },
    {
      id: "claude-bedrock", label: "Claude Bedrock", modelField: "defaultBedrockModel", effortField: "defaultBedrockEffort",
      directory: bedrockLoginHome(),
      command: `install -d -m 700 ${shellQuote(bedrockLoginHome())} && CLAUDE_CONFIG_DIR=${shellQuote(bedrockLoginHome())} claude`,
      description: "Run on the gateway host as the gateway service user, then type /setup-bedrock. Choose an Amazon Bedrock API key, your AWS region and model pins. This integration supports the Bedrock bearer API key method; AWS profile, SSO and IAM access-key signing are not supported. Usage is billed by AWS; costs are recorded as tokens only.",
    },
  ];
}
