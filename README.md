# wm-autopilot

Agent-first CLI for Coworker v4 / SuperBased workspaces.

State lives in:

- `~/.wingman-ap/autopilot.db`
- `~/.wingman-ap/config.json` fallback mirror of the active connection config

Bootstrap:

```bash
export WINGMAN_AUTOPILOT_NSEC=...
cd ~/code/superbased/coworker/wm-autopilot
bun install
node src/cli.js init --token "<connection_token>"
node src/cli.js sync
```

You can also pass the full Agent Connect JSON package to `init --token`; the CLI
will extract `.connection_token` automatically.

Local execution during development:

```bash
cd ~/code/superbased/coworker/wm-autopilot
bun run start -- status
node src/cli.js sync
```

Once published, the intended entrypoints are:

```bash
npx wingman-autopilot status
bunx wingman-autopilot status
```

Example commands:

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
node src/cli.js chat create --title "WM21 temp"
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

Tests:

```bash
cd ~/code/superbased/coworker/wm-autopilot
node --test
```
