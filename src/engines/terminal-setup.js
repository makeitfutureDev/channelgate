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
      description: "Sign in on the gateway host as the gateway service user, choosing your intended ChatGPT workspace (including Pro Lite). Enterprise is not required. EU data and inference residency depend on that workspace’s available controls and configuration. A separate login alone does not enforce residency. This harness never falls back to another account.",
    },
    {
      id: "claude-bedrock", label: "Claude Extra", modelField: "defaultBedrockModel", effortField: "defaultBedrockEffort",
      directory: bedrockLoginHome(),
      command: `install -d -m 700 ${shellQuote(bedrockLoginHome())} && CLAUDE_CONFIG_DIR=${shellQuote(bedrockLoginHome())} claude`,
      description: "Run on the gateway host as the gateway service user and sign in with a separate Claude subscription. For Amazon Bedrock instead, type /setup-bedrock and choose an API key, your AWS region and model pins. AWS profile, SSO and IAM access-key signing are not supported. A saved AWS setup stays on Bedrock until you remove its provider environment settings. This login never borrows the regular Claude account. Bedrock usage is billed by AWS; dollar costs remain unknown.",
    },
  ];
}
