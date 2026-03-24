# Wingman-Yoke

Wingman-Yoke is the CLI that agents and operators use to interact with Coworker workspaces through SuperBased. It provides local SQLite-backed access to tasks, chat, docs, storage, and more.

## Quickstart

### 1. Install

```bash
# From npm
npm install -g wingman-yoke

# Or run directly
npx wingman-yoke --help
```

For local development:

```bash
git clone https://github.com/humansinstitute/wingman-yoke.git
cd wingman-yoke
npm install
```

**Requires Node >= 20.**

### 2. Set your identity

```bash
export WINGMAN_YOKE_NSEC=nsec1...
```

### 3. Initialize with a connection token

```bash
wingman-yoke init --token "<connection_token>"
```

You can also pass the full Agent Connect JSON package — Yoke extracts `.connection_token` automatically.

### 4. Sync workspace data

```bash
wingman-yoke sync
```

This pulls workspace records into your local SQLite mirror at `~/.wingman-yoke/yoke.db`.

### 5. Start working

```bash
# Check connection status
wingman-yoke status

# List and manage tasks
wingman-yoke tasks list
wingman-yoke tasks create --title "New task"
wingman-yoke tasks comment <task-id> --body "Update here"

# Chat
wingman-yoke chat channels
wingman-yoke chat send <channel-id> --body "Hello"

# Docs
wingman-yoke docs list
wingman-yoke docs create --title "Notes" --content "hello world"
```

> **Tip:** When running from a local clone, replace `wingman-yoke` with `node src/cli.js`.

## State

By default, state lives in:

- `~/.wingman-yoke/yoke.db` — local SQLite mirror
- `~/.wingman-yoke/config.json` — workspace config

Environment variables:

- `WINGMAN_YOKE_STATE_DIR` — override state directory
- `WINGMAN_YOKE_NSEC` — agent/operator identity

Legacy fallbacks (`WINGMAN_AP_STATE_DIR`, `WINGMAN_AUTOPILOT_NSEC`, `autopilot.db`) are still supported.

## Command Reference

```bash
node src/cli.js status
node src/cli.js getLatest

node src/cli.js tasks list
node src/cli.js tasks create --title "New task"
node src/cli.js tasks update <task-id> --state in_progress
node src/cli.js tasks comment <task-id> --body "Looks good"
node src/cli.js tasks reply <comment-id> --body "Following up"
node src/cli.js tasks comment-image <task-id> --file ./image.png --body "See this"
node src/cli.js tasks voice <task-id> --file ./voice.aiff --body "Voice note"

node src/cli.js chat channels
node src/cli.js chat create --title "Yoke temp"
node src/cli.js chat messages <channel-id>
node src/cli.js chat send <channel-id> --body "Hello"
node src/cli.js chat reply <channel-id> --thread <message-id> --body "Reply"
node src/cli.js chat image <channel-id> --file ./image.png --body "Screenshot"
node src/cli.js chat voice <channel-id> --file ./voice.aiff --body "Voice note"

node src/cli.js docs list
node src/cli.js docs create --title "Scratch doc" --content "hello"
node src/cli.js docs show <doc-id>
node src/cli.js docs update <doc-id> --content-file ./doc.md
node src/cli.js directories create --title "Projects"
node src/cli.js directories list
node src/cli.js directories show <directory-id>
node src/cli.js directories update <directory-id> --title "Renamed"
node src/cli.js docs comment <doc-id> --body "Needs work" --line 12
node src/cli.js docs reply <comment-id> --body "Updated"
node src/cli.js docs comment-image <doc-id> --file ./image.png --line 12
node src/cli.js docs voice <doc-id> --file ./voice.aiff --line 12

node src/cli.js scopes create --title "Flight Deck" --level product
node src/cli.js scopes list
node src/cli.js scopes show <scope-id>
node src/cli.js scopes update <scope-id> --title "Flight Deck Core"

node src/cli.js storage upload ./image.png
node src/cli.js audio list
node src/cli.js audio show <audio-note-id>
node src/cli.js audio update-transcript <audio-note-id> --transcript "Transcript text"
```

## Development

```bash
# Run commands locally
node src/cli.js status
node src/cli.js sync

# Run tests
npm test
```

Schema compatibility is part of the Yoke test suite. It validates Yoke's supported outbound families against the published Flight Deck manifests in `../sb-publisher/schemas/flightdeck`.
