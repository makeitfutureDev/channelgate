#!/usr/bin/python3
"""Research-only Perplexity subscription MCP; never runs the upstream general MCP.

The daemon writes a destination-bound relay placeholder into the channel HOME.
Only the egress proxy sees the real login. Each call has a separate, cancellable
worker: no workspace files, uploads, private connectors or saved conversations.
"""

import asyncio
import json
import os
from pathlib import Path
import re
import sys
from typing import Annotated, Literal

MAX_PROMPT = 16_000
MAX_ANSWER = 80_000
MAX_CITATIONS = 100
MAX_WORKER_OUTPUT = 2_000_000
TOKEN_PATH = Path.home() / ".config/perplexity-web-mcp/token"
FAILURE = "Perplexity request failed. Check the subscription login in Settings, network access and remaining quota."
SOURCES = {"web": "web", "academic": "scholar", "social": "social", "finance": "edgar"}


def _relay_token() -> str:
    # Do not follow a final-component symlink or read an arbitrary-sized file.
    fd = os.open(TOKEN_PATH, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        token = stream.read(128).strip()
    if not re.fullmatch(r"cgph_r[a-z2-7]{32}", token):
        raise ValueError("Perplexity relay is unavailable.")
    return token


def _network() -> None:
    """Force curl_cffi to honor the gateway proxy and CA, including report downloads."""
    from curl_cffi.requests import Session
    import perplexity_web_mcp.core as core
    import perplexity_web_mcp.http as http

    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    ca = http.get_system_ca_bundle_path()
    if not proxy or not ca:
        raise ValueError("Perplexity requires the gateway egress proxy and CA.")

    def session(**kwargs):
        kwargs.update(proxy=proxy, verify=ca, trust_env=False)
        return Session(**kwargs)

    http.Session = session
    core.Session = session


def _catalog(http):
    from perplexity_web_mcp.catalog import parse_models_config
    from perplexity_web_mcp.constants import ENDPOINT_MODELS_CONFIG

    entries = parse_models_config(http.get(ENDPOINT_MODELS_CONFIG).json())
    # The upstream parser already excludes browser/computer-agent rows. Admit
    # only query modes; Labs and Deep Research cannot be smuggled into quick mode.
    return [e for e in entries if e.mode in ("", "copilot", "concise")
            and e.identifier not in ("pplx_beta", "pplx_alpha")]


def _usage(http) -> dict:
    from perplexity_web_mcp.constants import ENDPOINT_RATE_LIMITS

    data = http.get(ENDPOINT_RATE_LIMITS).json()
    # No raw settings/connector/account records are returned to the agent.
    return {key: value if isinstance(value := data.get(key), int) else None
            for key in ("remaining_pro", "remaining_research")}


def _worker(request: dict) -> dict:
    from loguru import logger
    from perplexity_web_mcp.config import ClientConfig, ConversationConfig
    from perplexity_web_mcp.core import Perplexity
    from perplexity_web_mcp.enums import CitationMode, SourceFocus
    from perplexity_web_mcp.http import HTTPClient
    from perplexity_web_mcp.models import Model, Models

    logger.remove()  # Exceptions/logs must never copy cookies into tool output.
    _network()
    token = _relay_token()
    action = request.get("action")
    with HTTPClient(token, timeout=30, max_retries=1, rotate_fingerprint=False) as http:
        if action == "models":
            return {"models": [{"id": e.identifier[:100], "name": e.label[:200],
                                "tier": e.tier[:100] if e.tier else None} for e in _catalog(http)[:100]],
                    "deep_research": True}
        quota = _usage(http)
        if action == "usage":
            return quota
        if action != "research":
            raise ValueError("Unsupported Perplexity operation.")
        prompt = request.get("prompt", "")
        mode = request.get("mode", "quick")
        source = request.get("source", "web")
        model_id = request.get("model")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT:
            return {"error": "Provide a non-empty research prompt of at most 16000 characters."}
        if mode not in ("quick", "deep") or source not in (*SOURCES, "all"):
            return {"error": "Unsupported research mode or public source."}
        if mode == "deep" and model_id:
            return {"error": "Deep Research selects its own model. Omit model or use quick mode."}
        remaining = quota["remaining_research" if mode == "deep" else "remaining_pro"]
        if remaining is not None and remaining <= 0:
            return {"error": "The subscription quota for this research mode is exhausted.", "quota": quota}
        model = Models.DEEP_RESEARCH if mode == "deep" else Models.BEST
        if model_id:
            entries = {e.identifier: e for e in _catalog(http)}
            entry = entries.get(model_id)
            if not entry:
                return {"error": "Model unavailable for research. Call perplexity_models for supported IDs."}
            model = Model(identifier=entry.identifier, mode=entry.mode or "copilot")

    config = ConversationConfig(
        model=model, citation_mode=CitationMode.DEFAULT, save_to_library=False,
        source_focus=[SourceFocus(value) for value in SOURCES.values()]
        if source == "all" else SourceFocus(SOURCES[source]),
    )
    with Perplexity(token, ClientConfig(timeout=840 if mode == "deep" else 150,
                                      max_retries=1, rotate_fingerprint=False)) as client:
        conversation = client.create_conversation(config)
        conversation.ask(prompt, files=None, stream=False)
        answer = conversation.answer or ""
        citations = [{"title": (item.title or "")[:500], "url": (item.url or "")[:2000]}
                     for item in conversation.search_results[:MAX_CITATIONS]]
        return {"answer": answer[:MAX_ANSWER], "citations": citations,
                "truncated": len(answer) > MAX_ANSWER or len(conversation.search_results) > MAX_CITATIONS,
                "mode": mode, "model": model.identifier, "quota_before": quota}


async def _call_worker(request: dict) -> dict:
    timeout = 900 if request.get("mode") == "deep" else 180 if request["action"] == "research" else 60
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-I", str(Path(__file__).resolve()), "--worker",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        output, _ = await asyncio.wait_for(
            process.communicate(json.dumps(request, ensure_ascii=False).encode("utf-8")), timeout=timeout,
        )
        if process.returncode or len(output) > MAX_WORKER_OUTPUT:
            raise ValueError(FAILURE)
        result = json.loads(output)
        if not isinstance(result, dict):
            raise ValueError(FAILURE)
        if "error" in result:
            raise ValueError(result["error"])
        return result
    except asyncio.TimeoutError:
        raise ValueError("Perplexity research timed out; the worker was stopped.") from None
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def _serve() -> None:
    from mcp.server.fastmcp import FastMCP
    from pydantic import Field

    mcp = FastMCP("perplexity_research_mcp")
    read_only = {"readOnlyHint": True, "destructiveHint": False,
                 "idempotentHint": False, "openWorldHint": True}

    @mcp.tool(annotations=read_only)
    async def perplexity_research(
        prompt: Annotated[str, Field(min_length=1, max_length=MAX_PROMPT)],
        mode: Literal["quick", "deep"] = "quick",
        model: Annotated[str | None, Field(max_length=100)] = None,
        source: Literal["web", "academic", "social", "finance", "all"] = "web",
    ) -> dict:
        """Delegate public-source research to the configured Perplexity subscription.

        Returns answer, ordered citations, quota and truncation status. Quick mode
        accepts IDs from perplexity_models; deep mode selects its own model and
        may take several minutes. Consumes subscription quota. Send a self-contained
        question and necessary context; the researcher cannot access workspace
        files, private connectors, chat history or execution tools.
        """
        return await _call_worker({"action": "research", "prompt": prompt,
                                   "mode": mode, "model": model, "source": source})

    @mcp.tool(annotations={**read_only, "idempotentHint": True})
    async def perplexity_usage() -> dict:
        """Return remaining Pro Search and Deep Research subscription quotas."""
        return await _call_worker({"action": "usage"})

    @mcp.tool(annotations={**read_only, "idempotentHint": True})
    async def perplexity_models() -> dict:
        """List live public research model IDs and subscription tiers."""
        return await _call_worker({"action": "models"})

    mcp.run(transport="stdio")


if __name__ == "__main__":
    if sys.argv[1:] == ["--worker"]:
        try:
            result = _worker(json.loads(sys.stdin.buffer.read(100_000)))
        except Exception:
            result = {"error": FAILURE}
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    elif not sys.argv[1:]:
        _serve()
    else:
        sys.exit("Usage: cg-perplexity-research (stdio MCP)")
