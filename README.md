# Wingman-Yoke

Wingman-Yoke is the CLI that the autopilot agent uses when it needs to steer Coworker workspaces through SuperBased.

## State

By default, state lives in:

- `~/.wingman-yoke/yoke.db`
- `~/.wingman-yoke/config.json`

Compatibility fallbacks are still supported for older installs:

- `WINGMAN_AP_STATE_DIR`
- `WINGMAN_AUTOPILOT_NSEC`
- legacy `autopilot.db` files

Preferred environment variables:

- `WINGMAN_YOKE_STATE_DIR`
- `WINGMAN_YOKE_NSEC`

## Bootstrap

From the repository root:

```bash
bun install
export WINGMAN_YOKE_NSEC=...
node src/cli.js init --token "<connection_token>"
node src/cli.js sync
```

You can also pass the full Agent Connect JSON package to `init --token`; Wingman-Yoke will extract `.connection_token` automatically.

## Development

```bash
bun run start -- status
node src/cli.js sync
```

Published entrypoints:

```bash
npx wingman-yoke status
bunx wingman-yoke status
```

## Example Commands

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
node src/cli.js docs comment <doc-id> --body "Needs work" --line 12
node src/cli.js docs reply <comment-id> --body "Updated"
node src/cli.js docs comment-image <doc-id> --file ./image.png --line 12
node src/cli.js docs voice <doc-id> --file ./voice.aiff --line 12

node src/cli.js storage upload ./image.png
node src/cli.js audio list
node src/cli.js audio show <audio-note-id>
node src/cli.js audio update-transcript <audio-note-id> --transcript "Transcript text"
```

## Tests

```bash
node --test
```
