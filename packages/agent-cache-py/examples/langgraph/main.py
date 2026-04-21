"""
LangGraph + betterdb-agent-cache example

Demonstrates three caching tiers working together:
  1. Graph state persistence — BetterDBSaver stores checkpoints in Valkey
     so a conversation thread can be resumed across process restarts
  2. LLM response caching   — identical LLM calls return from Valkey
  3. Tool result caching    — repeated tool calls skip the (simulated) API

Usage:
  docker run -d --name valkey -p 6379:6379 valkey/valkey:8
  pip install betterdb-agent-cache[langgraph] langchain-openai
  export OPENAI_API_KEY=sk-...
  python main.py
"""
from __future__ import annotations

import asyncio
import json
import random
from typing import Annotated

import valkey.asyncio as valkey_client
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict

from betterdb_agent_cache import AgentCache, ModelCost, TierDefaults
from betterdb_agent_cache.adapters.langchain import BetterDBLlmCache
from betterdb_agent_cache.adapters.langgraph import BetterDBSaver
from betterdb_agent_cache.types import AgentCacheOptions


class State(TypedDict):
    messages: Annotated[list, add_messages]


async def main() -> None:
    client = valkey_client.Valkey(host="localhost", port=6379)
    cache = AgentCache(AgentCacheOptions(
        client=client,
        tier_defaults={
            "llm":     TierDefaults(ttl=3600),
            "tool":    TierDefaults(ttl=300),
            "session": TierDefaults(ttl=86400),
        },
        cost_table={"gpt-4o-mini": ModelCost(input_per_1k=0.00015, output_per_1k=0.0006)},
    ))

    model = ChatOpenAI(model="gpt-4o-mini", temperature=0,
                       cache=BetterDBLlmCache(cache=cache))
    checkpointer = BetterDBSaver(cache=cache)

    async def get_weather(city: str) -> str:
        cached = await cache.tool.check("get_weather", {"city": city})
        if cached.hit:
            print(f"  [tool cache HIT]  get_weather({city!r})")
            return cached.response or ""
        print(f"  [tool cache MISS] get_weather({city!r}) — calling API…")
        result = json.dumps({
            "city": city,
            "temperature": round(15 + random.random() * 15),
            "condition": random.choice(["sunny", "cloudy", "rainy"]),
        })
        await cache.tool.store("get_weather", {"city": city}, result)
        return result

    _TOOLS = [{"type": "function", "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    }}]
    model_with_tools = model.bind_tools(_TOOLS)

    async def call_model(state: State) -> dict:
        response = await model_with_tools.ainvoke(state["messages"])
        return {"messages": [response]}

    async def call_tools(state: State) -> dict:
        last: AIMessage = state["messages"][-1]
        results = []
        for tc in getattr(last, "tool_calls", []) or []:
            if tc["name"] == "get_weather":
                result = await get_weather(tc["args"].get("city", ""))
                results.append(ToolMessage(content=result, tool_call_id=tc["id"]))
        return {"messages": results}

    def should_continue(state: State) -> str:
        last: AIMessage = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    graph = (
        StateGraph(State)
        .add_node("agent", call_model)
        .add_node("tools", call_tools)
        .add_edge("__start__", "agent")
        .add_conditional_edges("agent", should_continue)
        .add_edge("tools", "agent")
        .compile(checkpointer=checkpointer)
    )

    async def run_thread(thread_id: str, message: str) -> None:
        print(f"\nUser [{thread_id}]: {message}")
        start = asyncio.get_event_loop().time()
        result = await graph.ainvoke(
            {"messages": [HumanMessage(message)]},
            config={"configurable": {"thread_id": thread_id}},
        )
        elapsed = asyncio.get_event_loop().time() - start
        last: AIMessage = result["messages"][-1]
        print(f"Assistant: {last.content}  ({elapsed * 1000:.0f} ms)")

    print("═══ Part 1: Graph State Persistence ═══")
    print("Two messages on the same thread — graph resumes from checkpoint.\n")
    await run_thread("demo-thread-1", "What is the weather in Sofia?")
    await run_thread("demo-thread-1", "And in Berlin?")

    print("\n═══ Part 2: LLM + Tool Caching ═══")
    print("Same questions, new thread — results served from cache.\n")
    await run_thread("demo-thread-2", "What is the weather in Sofia?")
    await run_thread("demo-thread-2", "And in Berlin?")

    stats = await cache.stats()
    print("\n── Cache Stats ──")
    print(f"LLM tier:   {stats.llm.hits} hits / {stats.llm.misses} misses ({stats.llm.hit_rate:.0%})")
    print(f"Tool tier:  {stats.tool.hits} hits / {stats.tool.misses} misses ({stats.tool.hit_rate:.0%})")
    print(f"Cost saved: ${stats.cost_saved_micros / 1_000_000:.6f}")

    await cache.shutdown()
    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
