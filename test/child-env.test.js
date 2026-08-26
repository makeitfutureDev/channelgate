// Unit tests for the child-process env allowlist (C1). Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv } from "../src/engines/child-env.js";

test("passes through base session + engine vars", () => {
  const env = buildChildEnv(
    {},
    {
      PATH: "/usr/bin",
      HOME: "/home/x",
      USER: "x",
      LOGNAME: "x",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp",
      TERM: "xterm",
      LANG: "en_US.UTF-8",
      TZ: "Europe/Bucharest",
      LC_ALL: "en_US.UTF-8",
      XDG_CONFIG_HOME: "/home/x/.config",
      ANTHROPIC_API_KEY: "sk-ant-x",
      CLAUDE_CONFIG_DIR: "/home/x/.claude",
      OPENAI_API_KEY: "sk-x",
      CODEX_HOME: "/home/x/.codex",
      MCP_TIMEOUT: "30000",
      MCP_TOOL_TIMEOUT: "300000",
      HTTPS_PROXY: "http://proxy:8080",
      no_proxy: "localhost",
    }
  );
  for (const k of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "TZ",
    "LC_ALL", "XDG_CONFIG_HOME", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR",
    "OPENAI_API_KEY", "CODEX_HOME", "MCP_TIMEOUT", "MCP_TOOL_TIMEOUT",
    "HTTPS_PROXY", "no_proxy",
  ]) {
    assert.equal(env[k] !== undefined, true, `${k} should pass through`);
  }
});

test("strips daemon secrets (allowlist, not denylist)", () => {
  const env = buildChildEnv(
    {},
    {
      PATH: "/usr/bin",
      SLACK_BOT_TOKEN: "xoxb-secret",
      SLACK_APP_TOKEN: "xapp-secret",
      SLACK_SIGNING_SECRET: "sig-secret",
      CG_APPROVAL_SECRET: "approval-secret",
      ADMIN_PASSWORD: "hunter2",
      SLACK_CLIENT_SECRET: "oauth-secret",
      GATEWAY_PUBLIC_URL: "https://x",
      AWS_SECRET_ACCESS_KEY: "aws-secret", // an unknown future secret must not leak either
      SOME_RANDOM_VAR: "nope",
    }
  );
  assert.deepEqual(env, { PATH: "/usr/bin" });
});

test("does not pass unknown variables from formerly broad vendor families", () => {
  const env = buildChildEnv({}, {
    PATH: "/usr/bin",
    ANTHROPIC_FUTURE_SECRET: "no",
    OPENAI_NEW_BEARER_TOKEN: "no",
    CLAUDE_PLUGIN_SECRET: "no",
    CODEX_EXPERIMENTAL_CREDENTIAL: "no",
    XDG_VENDOR_SECRET: "no",
    LC_SECRET: "no",
    ANTHROPIC_API_KEY: "allowed-engine-auth",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "allowed-engine-auth" });
});

test("allows ssh-agent socket + CA bundle paths, still strips git/GitHub bearer vars", () => {
  const env = buildChildEnv(
    {},
    {
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock", // socket path, not a secret
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem", // public CA bundle path
      GH_TOKEN: "gho_secret", // bearer secrets must stay stripped
      GITHUB_TOKEN: "ghp_secret",
      GIT_ASKPASS: "/evil/helper", // GIT_ prefix = header/credential injection vectors
      GIT_CONFIG_PARAMETERS: "'http.extraheader=AUTHORIZATION: basic x'",
    }
  );
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
  });
});

test("extra merge is explicit and wins over inherited values", () => {
  const env = buildChildEnv({ PATH: "/override", CG_CHANNEL_ID: "C123", SKIP: undefined, NIL: null }, { PATH: "/usr/bin", HOME: "/home/x" });
  assert.equal(env.PATH, "/override");
  assert.equal(env.HOME, "/home/x");
  assert.equal(env.CG_CHANNEL_ID, "C123");
  assert.equal("SKIP" in env, false);
  assert.equal("NIL" in env, false);
});

test("non-string source values are skipped", () => {
  const env = buildChildEnv({}, { PATH: "/usr/bin", HOME: undefined, TERM: 42 });
  assert.deepEqual(env, { PATH: "/usr/bin" });
});

test("child PATH never contains the interactive launcher shim directory", async () => {
  const os = await import("node:os");
  const launcher = `${os.homedir()}/.claude-launcher`;
  const env = buildChildEnv({}, { PATH: `/opt/homebrew/bin:${launcher}:/usr/bin:${launcher}/:${os.homedir()}/.local/bin` });
  // The wrapper menu between the gateway and the real CLI exec-looped every run in the
  // 2026-08-06 outage (its self-detection assumed the daemon's HOME). Children resolve engines
  // from the real install dirs only.
  assert.equal(env.PATH.includes(".claude-launcher"), false);
  assert.ok(env.PATH.includes("/opt/homebrew/bin"));
  assert.ok(env.PATH.endsWith("/.local/bin"));
});
