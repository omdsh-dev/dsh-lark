# dsh-lark · DeepSeek Harness plugin for Feishu / Lark

[![npm](https://img.shields.io/npm/v/dsh-lark-channel)](https://www.npmjs.com/package/dsh-lark-channel) [![CI](https://github.com/omdsh-dev/dsh-lark/actions/workflows/ci.yml/badge.svg)](https://github.com/omdsh-dev/dsh-lark/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

English | [简体中文](README.md)

**Put the DeepSeek Harness (DSH) you already run into Feishu/Lark.**

Hand your agent work from the chat, watch it run, switch workspace and model as you go. Questions, plan reviews, and tool approvals come back to the same conversation, so nothing sends you to a terminal. When it helps, put several agents in one group and let them work together.

## Quickstart

```sh
npm i -g dsh-lark-channel
dsh-lark-channel start
```

A QR code appears in the terminal. Scan it in Feishu to create the app, then DM the bot or @-mention it in a group.

Before the first dependency install, the command writes the profile's pnpm build policy: an unapproved dependency build script is warned about and skipped rather than failing the install, and protobufjs's notice-only postinstall is recorded as skipped by name. No manual `pnpm approve-builds` step is needed.

Prefer to install nothing? Run it through npx instead — every later command then carries the same prefix:

```sh
npx dsh-lark-channel@latest start
```

If DeepSeek Harness itself is not installed yet:

```sh
npm i -g @deepseek-ai/dsh
```

No public server, no callback URL.

## Why bother

- **Nothing to sit and watch.** Start the work from Feishu and check on it whenever.
- **More than a chatbot.** It switches real workspaces and models, and runs the commands and tools your Harness already has.
- **The decisions stay yours.** Model questions, plan reviews, and tool approvals land in the chat; a button or a sentence answers them.
- **Contexts stay apart.** Each chat, topic, and workspace keeps its own session.
- **Agents can work together.** One command adds another bot; in a group they hand the turn over by @-mentioning each other, with a hop limit that stops an endless exchange.

## A first run

Look around:

```text
/status
/ws
/cd my-project
/model
```

Then give it something to do:

```text
Find out why this project fails to build. Plan it first, and check with me before changing anything.
```

The work shows up in Feishu as it happens, and anything needing you arrives as a question, a plan, or an approval card. This channel's own wording renders in each reader's Feishu language.

## What it does

| Capability | What you get |
|---|---|
| Durable sessions | Survive a restart; the next message continues where you were, and `/new` starts over in place |
| Workspaces | `/ws` lists, `/cd` switches; returning to one resumes the work you left there |
| Model switching | `/model` opens a picker; the session and its context carry over, and the default is one press away |
| Native run view | Reasoning, tool calls, and results as a thinking process, with the answer sent on its own |
| Cards that ask | Single or multiple choice, or type an answer; approve a plan or send feedback; allow or refuse a tool call |
| Live status | `/status` shows workspace, model, and session — plus context occupancy and token totals where the host meters them — and refreshes in place |
| Session scope | One agent per chat, per topic thread, or per person in a shared chat |
| Several agents | Each bot keeps its own settings, credential, and sessions, and two of them can talk in one group |
| Slash commands | Host commands (`/plan`, `/compact`, `/permission`, …) run straight through the DSH command runtime |
| File transfer | A file sent into the chat becomes something the agent can read from the workspace; sending one back shows a group an approval card first |

## Commands

| Command | What it does |
|---|---|
| `/status` | Show and refresh workspace, model, and session; context and tokens where available |
| `/ws` | List the workspaces this channel can reach |
| `/cd <name or path>` | Switch this conversation's workspace |
| `/get <path>` | Send a workspace file to the chat |
| `/model` | Open the model picker |
| `/model use <provider/model>` | Switch without opening a card |
| `/model reset` | Back to the deployment default |
| `/new` | Start a fresh session in place; workspace and model stay |
| `/stop` | Stop the running task |
| `/help` | Everything this chat accepts, host commands included |

## Running it

On macOS and systemd Linux the bot runs as a user service, so closing the terminal leaves it up:

```sh
dsh-lark-channel status
dsh-lark-channel logs -f
dsh-lark-channel restart
dsh-lark-channel stop
```

Started through npx, those same commands carry the `npx dsh-lark-channel@latest` prefix — the tool prints whichever form you are using, so what you read is what you can paste.

To upgrade:

```sh
dsh-lark-channel upgrade
```

That installs the newest CLI and restarts the bot on it. Through npx there is nothing to upgrade — `npx dsh-lark-channel@latest start` already runs the newest — and either way `start` and `status` mention a newer release when one exists.

When the connection drops, the channel rebuilds its WebSocket under a quota and a backoff, so a live process is never a silently dead bot.

### More agents

Give a second Feishu app its own agent:

```sh
dsh-lark-channel add reviewer
```

It writes the new row, restarts, and shows that bot's QR code. Once scanned it has its own settings, app secret, and sessions — nothing shared with the first.

Put both in one group and they hand the turn over by mentioning each other: one finishes a change and @s the reviewer, who can @ back for another pass. Six consecutive bot turns by default, and anyone speaking refills that. To take one out:

```sh
dsh-lark-channel remove reviewer
```

Its credential and settings stay, so adding the same name back reaches the same bot.

To run Feishu inside the profile `dsh web` already uses:

```sh
dsh plugin --profile web add dsh-lark-channel@latest
dsh web
```

<details>
<summary>Permissions and advanced options</summary>

- The app's visibility scope decides who can reach the bot at all; `senderAllowlist`, `groupAllowlist`, and `approvers` narrow it further.
- `workspaceRoots` fences the directories a chat may switch into.
- `sessionScope` is `chat`, `chat-thread`, or `chat-sender`.
- `instance` names an extra bot row; the first stays unnamed, which keeps its settings and sessions exactly where they are.
- `botPeers` restricts which bots are answered; `botHops` bounds consecutive bot turns (six).
- A card that changes state is bound to the chat it was sent to: forwarded elsewhere, it governs nothing.
- Where the deployment composes a credentials service, the scanned app secret is stored there; one written into settings by an older version moves on the next boot.
- Image input is off by default: turn on `attachImages` only for a model you know accepts images.
- `receiveFiles` is on by default: inbound files land under `.dsh-lark/inbox/<timestamp>-<message hash>/` in the conversation's workspace and are never cleaned up automatically — that's on you. The first file into a workspace prompts a suggestion to add `.dsh-lark/` to `.gitignore`, but the channel never edits that file itself.
- `sendFiles` is on by default too: a direct message sends straight through, a group shows an approval card on every send — carrying where the file sits inside the workspace, the workspace's own name, and the size, rather than an absolute host path everyone in the room would read. There is no setting to turn that group approval off, since it would be an official back door for a prompt-injection exfiltration chain.
- An outbound file is only ever named by where it sits inside the workspace. No absolute host prefix reaches anything a person or the model reads — including the filesystem's own message when a read fails, both in the `/get` reply and in what `send_file` tells the model. The failure branch is precisely the one a prompt injection can provoke on purpose.
- One group holds at most three files awaiting a decision. A group send reads the whole file into memory before the room is asked, so that what the room approves is the artifact that leaves — which means the number of undecided sends has to be bounded. A fourth is refused outright and the model is told to wait for the standing ones. The number is not configurable: raising it buys back the memory risk and the approval fatigue together.
- Settled approval cards record who decided: when the callback omits a name, the channel best-effort resolves it from the current chat roster. Missing roster permission, lookup failures, or departed members safely show the open id instead and never block approval or file delivery.
- The single-file ceiling defaults to 20 MiB, set separately for each direction with `maxReceiveFileBytes` and `maxSendFileBytes`; documents (pdf / xlsx / docx) only ever arrive as a download with no online preview, because the upstream SDK uploads every general file as the `stream` type instead of inferring one from the extension.
- Voice messages land on disk like any other file; nothing transcribes them.
- Configuration is read at startup; changing it needs a restart.

</details>

## Requirements

- Node.js `^22.19.0 || >=24`
- DeepSeek Harness `0.1.0-rc.6` or newer
- A Feishu or Lark tenant

A native thinking process needs Feishu PC 7.70 / mobile 7.74 or newer; older clients can use `output: 'stream'`.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

## License

[BSD-3-Clause](LICENSE)

An unofficial community plugin, not affiliated with, authorized by, or endorsed by DeepSeek, Feishu, or Lark.
