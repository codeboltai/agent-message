# Agent-message

Agent-message is a CLI-first communication layer for agents. It gives agents one consistent way to send direct messages, read mailboxes, inspect threads, and reply across provider types.

V1 is self-contained and includes:

- named agent identities in shared config
- contacts with provider-specific handles
- shared append-only JSONL state
- local provider for offline development
- federation provider and sample HTTP server
- email providers for AgentMail, OpenMail, Robotomail, Nuntly, Lumbox, and AGMail
- provider contracts for future social and custom adapters

## Quickstart

```bash
npm install
npm run build
npm run dev -- config init
npm run dev -- agents create alice --name "Alice Agent"
npm run dev -- agents create bob --name "Bob Agent"
npm run dev -- contacts create bob --name "Bob Agent"
npm run dev -- contacts add-handle bob --provider local --address local:bob --account alice-local --primary
npm run dev -- send --agent alice --to bob --text "hello from alice"
npm run dev -- mailbox list --agent bob --account bob-local
```

## Config

Config is autoloaded from:

1. `--config <path>`
2. `AGENT_MESSAGE_CONFIG`
3. `./agent-message.yaml`
4. `~/.config/agent-message/config.yaml`

Mutable message state is stored separately as JSONL under `~/.local/share/agent-message` by default.

## Email Providers

Email providers can be added directly in config or created lazily with `accounts create <provider>`.

- `agentmail`: set `AGENTMAIL_API_KEY`
- `openmail`: set `OPENMAIL_API_KEY`
- `robotomail`: set `ROBOTOMAIL_API_KEY`; optionally configure `providers.robotomail.settings.domainId`
- `nuntly`: set `NUNTLY_API_KEY`; optionally configure `providers.nuntly.settings.domainId` or `namespaceId`
- `lumbox`: set `LUMBOX_API_KEY`
- `agmail`: set `AGMAIL_API_KEY`; optionally configure `providers.agmail.settings.domain`

All providers support the same CLI surface: `send`, `mailbox list`, `messages read`, `threads list`, `threads read`, and `threads reply`.
