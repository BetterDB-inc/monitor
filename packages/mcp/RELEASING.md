# Releasing @betterdb/mcp

1. Bump `package.json` and both versions in `server.json` to the new version, and move the Claude plugin pin in `claude-plugin/.mcp.json` and every launch snippet to it. Bump `claude-plugin/.claude-plugin/plugin.json` too, since Claude Code only updates installed plugins when that version changes.
2. Publish from the PR branch: push the `mcp-vX.Y.Z` tag on the branch's head commit so the release workflow publishes to npm.
3. Rerun Constants Guard on the PR. `mcp-versions` passes once the pinned version is on npm.
4. Merge the PR.

The marketplace installs the plugin from `master`, so the pin must never land there before its version is on npm.
