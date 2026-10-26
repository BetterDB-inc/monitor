import json
from importlib.metadata import version

import redis
from llama_index.core.llms import ChatMessage, MessageRole
from llama_index.storage.chat_store.redis import RedisChatStore

import common

PORT = 6380
PREFIX = "sxfix:li:"
ROLES = {
    "system": MessageRole.SYSTEM,
    "human": MessageRole.USER,
    "ai": MessageRole.ASSISTANT,
    "tool": MessageRole.TOOL,
}


def to_message(m):
    kwargs = {}
    if m["role"] == "ai" and m.get("toolCalls"):
        kwargs["tool_calls"] = [
            {
                "id": c["id"],
                "type": "function",
                "function": {"name": c["name"], "arguments": json.dumps(c["args"])},
            }
            for c in m["toolCalls"]
        ]
    if m["role"] == "tool":
        kwargs["tool_call_id"] = m["toolCallId"]
        kwargs["name"] = m.get("name")
    return ChatMessage(role=ROLES[m["role"]], content=m["content"], additional_kwargs=kwargs)


def main():
    client = redis.Redis.from_url(common.url(PORT))
    common.purge(client, PREFIX + "*")
    sessions = common.load_sessions()
    for sid, s in sessions.items():
        store = RedisChatStore(redis_url=common.url(PORT), ttl=s["ttl"])
        key = PREFIX + sid
        for m in s["messages"]:
            store.add_message(key, to_message(m))
    common.write_seed(
        "llamaindex",
        {
            "version": version("llama-index-storage-chat-store-redis"),
            "preset": "llamaindex",
            "namespace": PREFIX + "*",
            "port": PORT,
        },
        common.build_expectations(sessions),
    )


main()
