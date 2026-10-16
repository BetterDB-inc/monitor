from importlib.metadata import version

import redis
from langchain_community.chat_message_histories import RedisChatMessageHistory

import common

PORT = 6380
PREFIX = "sxfix:lcc:"


def main():
    client = redis.Redis.from_url(common.url(PORT))
    common.purge(client, PREFIX + "*")
    sessions = common.load_sessions()
    for sid, s in sessions.items():
        history = RedisChatMessageHistory(
            session_id=sid, url=common.url(PORT), key_prefix=PREFIX, ttl=s["ttl"]
        )
        for m in s["messages"]:
            history.add_message(common.lc_message(m))
    common.write_seed(
        "langchain-community",
        {
            "version": version("langchain-community"),
            "preset": "langchain-community",
            "namespace": PREFIX + "*",
            "port": PORT,
        },
        common.build_expectations(sessions),
    )


main()
