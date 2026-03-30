# Wingman Yoke Agent Guide

Use this file for work inside `wingman-yoke/`. Keep `agents.md` and `claude.md` identical.

## What this repo owns

`wingman-yoke` is the operator and agent CLI for Wingman Be Free.

It owns:

- CLI commands and operator workflows
- local SQLite mirror of shared workspace data
- Tower HTTP client behavior
- sync/materialization into local tables
- outbound payload builders for shared record families
- storage upload helpers and attachment rendering for agent use
- token/bootstrap config stored on the local machine

It does not own:

- Tower authority rules
- browser UX
- schema publication itself
- optional Flight Logs internals

## Read this first

- repo purpose: `README.md`
- shared workspace framing: `../README.md`
- current architecture: `../ARCHITECTURE.md`
- implementation seams: `../design.md`
- CLI entrypoint: `src/cli.js`
- Tower client: `src/client.js`
- local DB: `src/db.js`
- sync/materialization: `src/sync.js`

## Code map

- `src/cli.js`: command surface and operator flow
- `src/client.js`: authenticated Tower client
- `src/config.js`: local config bootstrap and persistence
- `src/token.js`: connection token parsing
- `src/db.js`: SQLite schema and migrations
- `src/sync.js`: pulls Tower data into local SQLite
- `src/translators.js`: inbound and outbound record translators
- `src/storage.js`: storage upload and attachment helpers
- `src/render.js`: storage-link rendering helpers
- `src/nostr.js`: key handling, NIP-44 helpers, session identity
- `tests/`: CLI, sync, translator, storage, and schema compatibility coverage

## Ownership by area

- bootstrap and local config: `src/config.js`, `src/token.js`
- record fetch/materialization: `src/client.js`, `src/sync.js`, `src/db.js`
- outbound family payloads: `src/translators.js`
- command UX: `src/cli.js`
- encrypted uploads and attachment references: `src/storage.js`, `src/render.js`

## Cross-app boundaries

Yoke is a peer client to Flight Deck. Shared seams include:

- Tower request and response contracts
- `connection_token`
- workspace owner identity
- group UUID and epoch semantics
- shared record family payloads
- storage metadata

When changing a shared family:

- update Tower if the contract changes
- update Flight Deck translators if the family is also browser-visible
- update schema compatibility coverage in `tests/schema-compat.test.js`
- keep published manifests in `../sb-publisher/schemas/flightdeck` aligned if payload shape changed

## Design rules

- Yoke should be able to operate from its local SQLite mirror for read-heavy workflows.
- CLI helpers should preserve Tower semantics, not invent separate Yoke-only contract rules.
- Shared payload builders must stay compatible with Flight Deck manifests.
- Group operations must stay explicit about membership and epoch semantics.
- Local convenience fields are fine in SQLite, but outbound payloads must remain contract-clean.

## Where to look for common tasks

- add a new CLI command:
  - `src/cli.js`
  - supporting client/storage/translator code
  - tests in `tests/`
- add a new shared record family:
  - inbound/outbound support in `src/translators.js`
  - local table in `src/db.js`
  - sync registration in `src/sync.js`
  - CLI command surface in `src/cli.js`
  - schema compatibility coverage in `tests/schema-compat.test.js`
- change auth or group-key behavior:
  - `src/nostr.js`
  - `src/client.js`
  - related tests

## Things to avoid

- Do not hard-code assumptions that differ from Tower route semantics.
- Do not add a payload shape to Yoke without checking the published schema and Flight Deck translator.
- Do not treat the CLI identity, workspace owner identity, and group identity as interchangeable.
- Do not make Flight Logs mandatory for normal CLI sync or mutation commands.

## Validation

- `bun run test`

For authenticated local integration flows, use the shared identity in `../tmp/nsec.md`.
