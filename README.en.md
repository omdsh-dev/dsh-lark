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

## Install from source

The quickstart above installs the released package from npm; this repository is the plugin's source. Installing it into DSH as a plugin takes four steps.

**1. Prerequisites.** Node.js `^22.19.0 || >=24`, and DSH `0.2.0-rc.1` or newer — install it first if you have not:

```sh
npm i -g @deepseek-ai/dsh
```

**2. Clone and build.** `lib/` is not in the repository (see `.gitignore`), while `main`, `exports`, and `bin` all point into it, so the build is a prerequisite of the install:

```sh
git clone https://github.com/omdsh-dev/dsh-lark.git
cd dsh-lark
pnpm install
pnpm build
```

`pnpm build` emits `lib/index.js`, `lib/cli.js`, and the browser half's `lib/client.js`. `pnpm run prepare` — the path a Git or tarball install takes, which `pnpm install` also runs — emits the same set: the Host declarations, the Client face's declarations and JavaScript, and the same `lib/client.js`. The only difference is that it clears `lib/` and rebuilds everything, so day-to-day edits are faster with `pnpm build`.

**3. Install into a profile.** `dsh plugin` forwards its arguments to pnpm inside the profile directory, and a relative path is resolved against the directory you run it from; a profile that does not exist yet is initialized with `@deepseek-ai/dsh-base`, and because this package declares `dsh.bundle` it is appended to `dsh.profile.bundles` as a link to this checkout:

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config   # optional: shows a dsh-lark-channel layer
```

Name the profile `web` if you want the web-side approval and question panels: a profile name with no shipped template is initialized with `dsh-base` alone.

**4. Boot DSH.**

```sh
dsh web        # same as dsh --profile web
```

On a first boot with no credentials yet, the QR code is printed in **that terminal** — scan it in Feishu to create the app — or set `LARK_APP_ID` / `LARK_APP_SECRET` to skip the scan. Then DM the bot or @-mention it in a group.

After changing the source, `pnpm build` and restart `dsh web`: the profile links this checkout, so nothing needs re-adding. To verify or remove it:

```sh
dsh plugin --profile web list
dsh plugin --profile web remove dsh-lark-channel
```

> The `dsh-lark-channel` CLI in this repository (`lib/cli.js`) serves the released package: it installs `dsh-lark-channel` from npm at its own version rather than this checkout, so a source install does not go through it.

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
| Durable sessions | Survive a restart; the next message continues where you were, and `/new` starts over in place on a brand-new session id |
| Continue a session | `/sessions` pages through what this conversation may continue in its workspace — its own history, plus sessions opened in the web UI or CLI — and one press switches to it; a card accepts one pick, so switching again means sending `/sessions` again; `/cd` enters the session that other directory was left on (each directory remembers its own, and coming back returns to it), while `/new` mints a fresh one. Once it is on a session the chat also shows that session's output, a web-UI turn included, and **switching away stops it**: the chat mirrors only the session it is on, while the one it leaves stays with whoever was running it |
| Workspaces | `/ws` opens a workspace picker where one press switches; `/cd` switches directly by name or path; returning to one resumes the work you left there |
| Model switching | `/model` opens a picker; the session and its context carry over, and the default is one press away |
| Native run view | Reasoning, tool calls, and results as a thinking process, with the answer sent on its own |
| Cards that ask | Single or multiple choice, or type an answer; approve a plan or send feedback; allow or refuse a tool call |
| Permission presets | `/permission` opens a picker saying what each preset may touch and whether it still asks; loosening the sandbox needs an approver, tightening it does not |
| Live status | `/status` shows workspace, model, session, and the permission preset in force — plus context occupancy and token totals where the host meters them — and refreshes in place; a session the host archived is named as such, with what the next message will meet |
| Session scope | One agent per chat, per topic thread, or per person in a shared chat |
| Several agents | Each bot keeps its own settings, credential, and sessions, and two of them can talk in one group |
| Slash commands | Host commands (`/plan`, `/compact`, …) run straight through the DSH command runtime |
| File transfer | A file sent into the chat becomes something the agent can read from the workspace; sending one back shows a group an approval card first |
| Web sync | An approval or question settled on another surface retires itself on the web panel instead of waiting for a press that no longer decides anything |

### The web-side approval panel

One approval appears on two surfaces at once — the Feishu card and the web panel — and the first answer wins. When the chat answers first, this page's copy of the question has already stopped deciding anything, but that panel belongs to the host, and the host settles a forwarded request only when a client replies or the request's lifetime ends. This plugin supplies the missing half: it reads the `approval/asked` / `approval/decided` audit pair out of the session log, recognises that another surface already settled the request, says so on the web panel, and retires it.

**This applies to every conversation, not only the channel's own.** That is the reach of a chain selector rather than a widening of scope: a selector is a pure function of the owner props — the session id, the session snapshot, and the pending request — and can read **no live fact at all**. Whether a particular chat is currently driving a conversation exists only on the host (the binding table, or the channel's own session projection). A session id cannot answer it either: `/sessions` lets a chat continue a session it did not derive, so a conversation this channel drives may carry any id. Claiming narrowly by name missed those, and the request it missed is exactly the one whose shipped panel keeps its buttons after the chat has already decided.

The cost is that this panel replaces the host's. It reproduces the Enter/Escape keys, the submission lock, the asker's reason text, and the correlated tool call's command — but `conversation.approval.detail` is declared by the host and a plugin cannot declare it again, so a third party's contribution to that slot will not render. On a conversation no chat drives, no other surface ever writes a decision, so this panel behaves as the host's does — apart from that slot, and apart from how the correlated command is read: the host shows it only while the tool call is in its start phase, while this panel still shows it once the call has completed.

The card is still sent and the two surfaces still race; when the web answers first, the settled card in the chat says where the decision came from ("decided in the web app") instead of reading as a press made here.

> **This is temporary.** The durable fix belongs in the host: the gateway should cancel delivered browsers when an earlier listener claims the waterfall, or the channel should register inside `forwardWaterfall` and share one settlement with the browser. When that lands, this browser half should be deleted rather than extended.

### The web-side question panel

A question (`ask_user_question`) likewise appears on both surfaces at once, and the first answer wins: the web copy reads the session log, recognises that another surface already answered, hands back the batch the log recorded — which is also how it withdraws itself, because the host finished that request long ago and drops the outcome there while this page's copy closes on it — and displays the log's own record rather than this browser's unfinished drafts, its status strip trading the waiting tone for a completion one. The recognition shares its skeleton with the approval panel — both read through the same settled-source registry — but the keys differ: an approval correlates by tool call (falling back to the tool name when the asker named no call), while a question correlates by **the batch's own questions**: count, ids, texts, headings, option labels in order, and the multiple-choice flag must all agree before a settlement counts as this request's. Recency cannot decide it — a blocking request carries no call id, and a model reuses ids across batches, so matching by newest or by id alone answers one question with another's answers (which is what happened: a `scope/depth/format` ask received the previous batch's `dir/scope/ui` answers). Every call in the window that left a successful result is read, and the newest one matching this request wins; a request nothing matches retires nothing and waits for a press exactly as the shipped panel does. When the card's own channel no longer accepts an answer, the withdrawal falls back to the dismissal the card offers; a card that refuses both says so instead of standing there as if it were still waiting. Beyond that it reproduces the host's question wizard item by item, so replacing it loses nothing:

- One question per page with a pager, previous/next, and collapsing the whole card;
- Skipping a question, answer validation, and the submission lock;
- **The countdown and "take time"**: the page can stop its own countdown, after which the host waits like a blocking question; editing a draft, focusing the answer surface, or leaving the window or the tab moves the countdown with the person (frozen or resumed). The deadline itself always belongs to the host — the panel only displays it;
- **Drafts survive a remount**, including the "take time" decision; once the request is gone they are pruned, so they cannot become the next request's answer;
- **A read-only review card**: a settled call reopens from its tool call row showing the recorded answers, with nothing to submit;
- **Closing means what it means on the host**: a request keyed by a tool call only withdraws the panel, which the tool call row reopens; a request the host never named ends the whole batch.

The panel root and its scroll area carry the host's own attributes (`data-question-key` / `data-question-scroll`), so client code and e2e selectors that depend on them keep working.

The card is still sent and the two surfaces still race; when the web answers first, the settled card in the chat says "answered in the web app", and the rest of that batch stops opening cards.

## Commands

| Command | What it does |
|---|---|
| `/status` | Show and refresh workspace, model, and session; context and tokens where available; an archived session is named, because the next message is refused until it is restored |
| `/ws` | Open the workspace picker; one press switches |
| `/cd <name or path>` | Switch this conversation's workspace |
| `/get <path>` | Send a workspace file to the chat; in a group it asks the room first, and the bytes leave only after someone allows it |
| `/model` | Open the model picker |
| `/model use <provider/model>` | Switch without opening a card |
| `/model reset` | Back to the deployment default |
| `/permission` | Open the permission-preset picker |
| `/permission <preset>` | Switch preset without opening a card |
| `/new` | Start a fresh session in place; workspace and model stay. Its id is minted on the spot, so it can never be one this conversation already ran; an archived session is neither revived nor silently overwritten |
| `/sessions` | Page through the sessions this conversation may continue, one press each; a card accepts one pick |
| `/sessions <keyword>` | Filter that list by title or id |
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

- The app's visibility scope decides who can reach the bot at all; `senderAllowlist`, `groupAllowlist`, and `approvers` narrow it further. `approvers` covers the plan review as well as approval cards — approving a plan leaves plan mode and starts executing it, which is a grant — while ordinary questions are not restricted by it.
- `workspaceRoots` fences the directories a chat may switch into.
- `sessionScope` is `chat`, `chat-thread`, or `chat-sender`.
- `instance` names an extra bot row; the first stays unnamed, which keeps its settings and sessions exactly where they are.
- `botPeers` restricts which bots are answered; `botHops` bounds consecutive bot turns (six).
- A card that changes state is bound to the chat it was sent to: forwarded elsewhere, it governs nothing.
- Where the deployment composes a credentials service, the scanned app secret is stored there; one written into settings by an older version moves on the next boot.
- Image input is off by default: turn on `attachImages` only for a model you know accepts images.
- `receiveFiles` is on by default: inbound files land under `.dsh-lark/inbox/<timestamp>-<message hash>/` in the conversation's workspace and are never cleaned up automatically — that's on you. The first file into a workspace prompts a suggestion to add `.dsh-lark/` to `.gitignore`, but the channel never edits that file itself.
- `sendFiles` is on by default too: a direct message sends straight through, a group shows an approval card on every send — carrying where the file sits inside the workspace, the workspace's own name, and the size, rather than an absolute host path everyone in the room would read. There is no setting to turn that group approval off, since it would be an official back door for a prompt-injection exfiltration chain.
- `/get` goes through the same check `send_file` does, so in a group it asks the room first too: the only difference between them is who started it, and what a group guards against is a file entering the room rather than who wanted it there. One person approving their own command is not theatre in a group — it is the boundary itself.
- An outbound file is only ever named by where it sits inside the workspace. No absolute host prefix reaches anything a person or the model reads — including the filesystem's own message when a read fails, both in the `/get` reply and in what `send_file` tells the model. The failure branch is precisely the one a prompt injection can provoke on purpose.
- One group holds at most three files awaiting a decision. A group send reads the whole file into memory before the room is asked, so that what the room approves is the artifact that leaves — which means the number of undecided sends has to be bounded. A fourth is refused outright and the model is told to wait for the standing ones. The number is not configurable: raising it buys back the memory risk and the approval fatigue together.
- Settled approval cards record who decided: when the callback omits a name, the channel best-effort resolves it from the current chat roster. Missing roster permission, lookup failures, or departed members safely show the open id instead and never block approval or file delivery.
- The single-file ceiling defaults to 20 MiB, set separately for each direction with `maxReceiveFileBytes` and `maxSendFileBytes`; documents (pdf / xlsx / docx) only ever arrive as a download with no online preview, because the upstream SDK uploads every general file as the `stream` type instead of inferring one from the extension.
- Voice messages land on disk like any other file; nothing transcribes them.
- Diagnostics reach the process terminal by default; name `diagnosticsFile` and this channel appends them to that file instead (a path with an extension is the file, anything else is a directory that holds `dsh-lark-diagnostics.log`), with `diagnosticsLevel` as the floor (default `warn`; `debug`/`info`/`warn`/`error`). `diagnoseSessions` is off by default and, when on, reports which candidate `/sessions` admitted or withheld, under which rule, plus the counts at each stage — the line count scales with the withheld records, which is what makes a short list attributable.
- Configuration is read at startup; changing it needs a restart. A workspace switch, a model switch, the session pointer (`/sessions` or `/new` wrote it) and a scanned credential are written back through the host's settings service and survive the restart; the schema fields carrying them are marked volatile, which is the condition the host requires before it will write at all — without the marking it refuses, and the channel would only remember them in memory while looking as if it had persisted them. A failed write now reaches both the console and `diagnosticsFile` instead of flashing past in a terminal. The older `chatEpochs` field is kept read-only: a conversation running on `--e<N>` still resumes, but nothing writes it any more.
- A rotated App Secret takes effect on restart: the channel hears the host's credentials event and re-resolves the reference, but the connection already built keeps the secret it was constructed with, so restart the service after changing one. The host's credential store also OUTRANKS the environment: a scanned secret lives there, so while that entry exists an exported `LARK_APP_SECRET` is ignored — changing the exported value alone does nothing until the stored reference is replaced or removed. The connection line names which source is live.

</details>

## Requirements

- Node.js `^22.19.0 || >=24`
- DeepSeek Harness `0.2.0-rc.1` or newer (the web-side approval and question panels need it; this repository is built and tested against `0.2.0-rc.2`)
- A Feishu or Lark tenant

A native thinking process needs Feishu PC 7.70 / mobile 7.74 or newer; older clients can use `output: 'stream'`.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

To install this source into DSH and boot it, see [Install from source](#install-from-source).

## License

[BSD-3-Clause](LICENSE)

An unofficial community plugin, not affiliated with, authorized by, or endorsed by DeepSeek, Feishu, or Lark.
