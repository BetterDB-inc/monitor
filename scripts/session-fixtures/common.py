import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ALLOWED_PORTS = (6380, 6384)
PASSWORD = os.environ.get("VALKEY_PASSWORD", "devpassword")
FILLER = "The quick brown fox jumps over the lazy dog. "


def assert_port(port):
    if port not in ALLOWED_PORTS:
        sys.exit(f"refusing port {port}: only 6380 and 6384 are allowed")


def url(port):
    assert_port(port)
    return f"redis://:{PASSWORD}@localhost:{port}/0"


def filler(chars, tag):
    text = f"[{tag}] " + FILLER * (chars // len(FILLER) + 1)
    return text[:chars]


def load_sessions():
    spec = json.loads((HERE / "session-spec.json").read_text())
    sessions = {}
    for sid, entry in spec.items():
        messages = []
        for m in entry["messages"]:
            m = dict(m)
            gen = m.pop("generate", None)
            if gen:
                m["content"] = filler(gen["chars"], gen["tag"])
            messages.append(m)
        if "oversize" in entry:
            cfg = entry["oversize"]
            for i in range(cfg["pairs"]):
                messages.append({"role": "human", "content": filler(cfg["chars"], f"q{i}")})
                messages.append({"role": "ai", "content": filler(cfg["chars"], f"a{i}")})
        sessions[sid] = {"messages": messages, "ttl": entry.get("ttl")}
    return sessions


def build_expectations(sessions):
    out = {}
    for sid, s in sessions.items():
        msgs = s["messages"]
        e = {
            "messages": len(msgs),
            "toolCalls": sum(len(m.get("toolCalls", [])) for m in msgs),
            "roles": [m["role"] for m in msgs],
            "hasTtl": s["ttl"] is not None,
        }
        if sid != "oversize":
            e["contents"] = [m["content"] for m in msgs]
        out[sid] = e
    return out


def write_seed(library, meta, expectations):
    path = HERE / "seed-expectations.json"
    data = json.loads(path.read_text()) if path.exists() else {}
    data[library] = {**meta, "expectations": expectations}
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def purge(client, pattern):
    for key in client.scan_iter(match=pattern, count=1000):
        client.unlink(key)


def lc_message(m):
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

    role = m["role"]
    if role == "system":
        return SystemMessage(content=m["content"])
    if role == "human":
        return HumanMessage(content=m["content"])
    if role == "ai":
        calls = [
            {"id": c["id"], "name": c["name"], "args": c["args"], "type": "tool_call"}
            for c in m.get("toolCalls", [])
        ]
        return AIMessage(content=m["content"], tool_calls=calls)
    return ToolMessage(content=m["content"], tool_call_id=m["toolCallId"], name=m.get("name"))
