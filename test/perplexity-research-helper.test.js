import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Exercise the real image helper against inert library doubles. No dependency
// installation, Perplexity login, quota consumption or outbound request occurs.
test("Perplexity helper admits only public research and sanitizes/cancels workers", () => {
  const script = String.raw`
import asyncio, enum, importlib.util, json, pathlib, sys, tempfile, types
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("research", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

def module(name, **values):
    obj = types.ModuleType(name)
    obj.__dict__.update(values)
    sys.modules[name] = obj
    return obj

class Config:
    def __init__(self, **values): self.__dict__.update(values)

class Focus(str, enum.Enum):
    WEB="web"; ACADEMIC="scholar"; SOCIAL="social"; FINANCE="edgar"
    PRIVATE="google_drive" # Future enum values must never widen 'all'.

class Model:
    def __init__(self, identifier, mode="copilot"):
        self.identifier, self.mode = identifier, mode

class Models:
    BEST=Model("pplx_pro")
    DEEP_RESEARCH=Model("pplx_alpha")

quota = {"remaining_pro": 4, "remaining_research": 2, "private_connector_secret": "hidden"}
entries = [Config(identifier="public-model", mode="copilot", label="Public", tier="pro"),
           Config(identifier="pplx_beta", mode="copilot", label="Labs", tier="pro"),
           Config(identifier="computer", mode="agent", label="Computer", tier="max")]

class HTTP:
    def __init__(self, *args, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def get(self, endpoint):
        return Config(json=lambda: quota if endpoint=="quota" else entries)

seen=[]
class Conversation:
    answer="answer[1]"
    search_results=[Config(title="Source", url="https://example.org")]
    def ask(self, prompt, **kwargs):
        assert kwargs == {"files": None, "stream": False}
        seen.append(prompt)

class Perplexity:
    def __init__(self, token, config): assert token.startswith("cgph_r")
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def create_conversation(self, config):
        assert config.save_to_library is False
        assert config.citation_mode == "default"
        sources = config.source_focus if isinstance(config.source_focus, list) else [config.source_focus]
        assert all(source.value in helper.SOURCES.values() for source in sources)
        seen.append(config)
        return Conversation()

module("loguru", logger=Config(remove=lambda: None))
module("perplexity_web_mcp")
module("perplexity_web_mcp.config", ClientConfig=Config, ConversationConfig=Config)
module("perplexity_web_mcp.core", Perplexity=Perplexity)
module("perplexity_web_mcp.enums", CitationMode=Config(DEFAULT="default"), SourceFocus=Focus)
module("perplexity_web_mcp.http", HTTPClient=HTTP)
module("perplexity_web_mcp.models", Model=Model, Models=Models)
module("perplexity_web_mcp.catalog", parse_models_config=lambda data: data)
module("perplexity_web_mcp.constants", ENDPOINT_MODELS_CONFIG="models", ENDPOINT_RATE_LIMITS="quota")

with tempfile.TemporaryDirectory() as tmp:
    token=pathlib.Path(tmp)/"token"
    helper.TOKEN_PATH=token
    token.write_text("cgph_r"+"a"*32)
    assert helper._relay_token() == "cgph_r"+"a"*32
    token.write_text("real-login-cookie")
    try: helper._relay_token(); raise AssertionError("accepted a real cookie")
    except ValueError: pass
    link=pathlib.Path(tmp)/"link"; link.symlink_to(token)
    helper.TOKEN_PATH=link
    try: helper._relay_token(); raise AssertionError("followed symlink")
    except OSError: pass

helper._network=lambda: None
helper._relay_token=lambda: "cgph_r"+"a"*32
quick=helper._worker({"action":"research", "prompt":"question", "source":"all"})
assert quick["answer"] == "answer[1]"
assert quick["citations"] == [{"title":"Source", "url":"https://example.org"}]
assert quick["model"] == "pplx_pro" and quick["truncated"] is False
assert len(seen[0].source_focus) == 4
deep=helper._worker({"action":"research", "prompt":"question", "mode":"deep"})
assert deep["model"] == "pplx_alpha"
custom=helper._worker({"action":"research", "prompt":"question", "model":"public-model"})
assert custom["model"] == "public-model"
for overrides in [{"source":"google_drive"}, {"model":"pplx_beta"}, {"model":"computer"},
                  {"mode":"deep", "model":"public-model"}, {"prompt":" "},
                  {"prompt":"x"*(helper.MAX_PROMPT+1)}]:
    assert "error" in helper._worker({"action":"research", "prompt":"question", **overrides})
quota["remaining_research"]=0
assert "exhausted" in helper._worker({"action":"research", "prompt":"q", "mode":"deep"})["error"]
assert helper._worker({"action":"usage"}) == {"remaining_pro":4, "remaining_research":0}
assert [x["id"] for x in helper._worker({"action":"models"})["models"]] == ["public-model"]
Conversation.answer="x"*(helper.MAX_ANSWER+1)
Conversation.search_results=[Config(title="T"*600, url="https://example.org/"+"a"*2000)]*101
large=helper._worker({"action":"research", "prompt":"q"})
assert large["truncated"] and len(large["answer"]) == helper.MAX_ANSWER
assert len(large["citations"]) == helper.MAX_CITATIONS
assert len(large["citations"][0]["title"]) == 500
assert len(large["citations"][0]["url"]) == 2000

registered={}
class MCP:
    def __init__(self, name): pass
    def tool(self, **options):
        def register(fn): registered[fn.__name__]=(fn, options); return fn
        return register
    def run(self, transport): assert transport=="stdio"
module("mcp");module("mcp.server");module("mcp.server.fastmcp", FastMCP=MCP)
module("pydantic", Field=lambda **kwargs: tuple(kwargs.items()))
helper._serve()
assert set(registered) == {"perplexity_research", "perplexity_usage", "perplexity_models"}
assert all(options["annotations"]["readOnlyHint"] for _, options in registered.values())

class Process:
    returncode=None
    killed=False
    fail=False
    oversized=False
    async def communicate(self, request):
        assert len(request) <= 100_000
        if self.fail: raise asyncio.TimeoutError()
        if self.oversized: return b"x"*(helper.MAX_WORKER_OUTPUT+1), b""
        self.returncode=0
        return json.dumps({"error":helper.FAILURE}).encode(), b""
    def kill(self): self.killed=True;self.returncode=-9
    async def wait(self): return self.returncode

async def subprocess_tests():
    process=Process()
    async def spawn(*args, **kwargs):
        assert args[1]=="-I" and args[-1]=="--worker"
        assert kwargs["stderr"] == asyncio.subprocess.DEVNULL
        return process
    with patch.object(asyncio, "create_subprocess_exec", spawn):
        try: await helper._call_worker({"action":"usage"}); raise AssertionError("ignored error")
        except ValueError as exc: assert str(exc)==helper.FAILURE
        try:
            await helper._call_worker({"action":"research", "prompt":"😀"*helper.MAX_PROMPT})
            raise AssertionError("ignored error")
        except ValueError as exc: assert str(exc)==helper.FAILURE
        process.returncode=None;process.fail=True
        try: await helper._call_worker({"action":"research"});raise AssertionError("ignored timeout")
        except ValueError as exc: assert "timed out" in str(exc)
        assert process.killed
        process.returncode=None;process.fail=False;process.killed=False;process.oversized=True
        try: await helper._call_worker({"action":"usage"});raise AssertionError("ignored output limit")
        except ValueError as exc: assert str(exc)==helper.FAILURE
        assert process.killed
        process.returncode=None;process.killed=False;process.oversized=False
        async def cancel(_): raise asyncio.CancelledError()
        process.communicate=cancel
        try: await helper._call_worker({"action":"usage"});raise AssertionError("ignored cancellation")
        except asyncio.CancelledError: pass
        assert process.killed
asyncio.run(subprocess_tests())
print("research helper verified")
`;
  const result = spawnSync("python3", ["-B", "-c", script, new URL("../containers/bin/cg-perplexity-research.py", import.meta.url).pathname], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /research helper verified/);
});
