# Agent Message

Agent Message is a provider-neutral communication layer for AI agents.

<p align="center">
  <img src="docs/assets/agent-message-overview.svg" alt="Agent Message connects AI agents and agent apps to local, federated, and email providers through one messaging layer." />
</p>

Agents often need to talk to users, other agents, support inboxes, or external mail systems, but each provider exposes a different account model, message format, and thread API. Agent Message gives agents one stable CLI and TypeScript runtime for sending messages, reading mailboxes, inspecting threads, and replying across local, federated, and email-backed providers.

This repository contains the full workspace. The published npm package is `@codebolt/agent-message`, which bundles the CLI, core runtime, federation server, and all built-in providers into one installable package.

## What It Provides

- One CLI command: `agent-message`
- Named agent identities stored in shared config
- Contacts with provider-specific handles
- Local JSONL-backed state for offline development and testing
- A local provider for same-machine agent messaging
- A federation provider plus sample HTTP federation server
- Email providers for AgentMail, OpenMail, Robotomail, Nuntly, Lumbox, and AGMail
- A TypeScript provider contract for adding future adapters

## Install

For normal use:

```bash
npm install -g @codebolt/agent-message
agent-message config init
agent-message providers list
```

For local workspace development:

```bash
npm install
npm run build
npm run dev -- config init
```

## Quickstart

Create two local agent identities, add a contact handle, send a message, and read the mailbox:

```bash
npm run dev -- config init
npm run dev -- agents create alice --name "Alice Agent"
npm run dev -- agents create bob --name "Bob Agent"
npm run dev -- --agent alice accounts create local --id alice-local --name "Alice Local" --address local:alice
npm run dev -- --agent bob accounts create local --id bob-local --name "Bob Local" --address local:bob
npm run dev -- contacts create bob --name "Bob Agent"
npm run dev -- contacts add-handle bob --provider local --address local:bob --account bob-local --primary
npm run dev -- --agent alice --account alice-local send --to bob --text "hello from alice"
npm run dev -- --agent bob --account bob-local mailbox list
```

With the published package, replace `npm run dev --` with `agent-message`.

## Configuration

Agent Message loads config from the first available source:

1. `--config <path>`
2. `AGENT_MESSAGE_CONFIG`
3. `./agent-message.yaml`
4. `~/.config/agent-message/config.yaml`

Mutable state is stored separately as append-only JSONL. By default it lives under:

```text
~/.local/share/agent-message
```

You can override the state directory with `AGENT_MESSAGE_STATE_DIR` or `state.dir` in config.

## CLI Surface

Core commands:

```bash
agent-message config init
agent-message config validate
agent-message config doctor
agent-message agents list
agent-message agents create <agentId> --name <name>
agent-message accounts list
agent-message accounts create <provider> --id <accountId> --name <name> --address <address>
agent-message contacts create <contactId> --name <name>
agent-message contacts add-handle <contactId> --provider <provider> --address <address>
agent-message providers list
agent-message providers capabilities <provider>
agent-message --agent <agentId> --account <accountId> send --to <contact-or-address> --text <message>
agent-message --agent <agentId> --account <accountId> mailbox list
agent-message --agent <agentId> --account <accountId> messages read <messageId>
agent-message --agent <agentId> --account <accountId> threads list
agent-message --agent <agentId> --account <accountId> threads read <threadId>
agent-message --agent <agentId> --account <accountId> threads reply <threadId> --text <message>
```

Use `--format json` on commands when another agent or script needs structured output.

## Providers

Built-in provider types:

| Provider | Type | Required environment |
| --- | --- | --- |
| Local | `local` | None |
| Federation | `federation` | Optional bearer token for server mode |
| AgentMail | `agentmail` | `AGENTMAIL_API_KEY` |
| OpenMail | `openmail` | `OPENMAIL_API_KEY` |
| Robotomail | `robotomail` | `ROBOTOMAIL_API_KEY` |
| Nuntly | `nuntly` | `NUNTLY_API_KEY` |
| Lumbox | `lumbox` | `LUMBOX_API_KEY` |
| AGMail | `agmail` | `AGMAIL_API_KEY` |

Provider-specific options can be set under `providers.<providerId>.settings` and `providers.<providerId>.auth` in `agent-message.yaml`.

## Federation Server

Agent Message includes a small HTTP federation server for cross-process or cross-machine message exchange.

```bash
agent-message server init
agent-message server start --host 127.0.0.1 --port 8787
```

The federation provider can then point to that server with:

```yaml
providers:
  federation:
    id: federation
    type: federation
    kind: custom
    settings:
      url: http://127.0.0.1:8787
```

## Package Layout

The workspace keeps implementation units separate, while the published package is bundled as one installable package.

```text
packages/agent-message              public npm package and bundled CLI
packages/core                       config, routing, provider types, JSONL store
packages/cli                        command implementation
packages/federation-server          sample HTTP federation server
packages/provider-local             local JSONL-backed provider
packages/provider-federation        HTTP federation provider
packages/provider-agentmail         AgentMail provider
packages/provider-openmail          OpenMail provider
packages/provider-robotomail        Robotomail provider
packages/provider-nuntly            Nuntly provider
packages/provider-lumbox            Lumbox provider
packages/provider-agmail            AGMail provider
```

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
npm pack --dry-run --json --workspace @codebolt/agent-message
```

The public package is intentionally self-contained. Internal workspace packages are private build units and should not appear as runtime dependencies in `packages/agent-message/package.json`.
