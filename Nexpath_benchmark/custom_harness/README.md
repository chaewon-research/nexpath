# NexPath session harness

A test harness that runs [NexPath](https://github.com/hi0001234d/nexpath) the way a developer
actually uses it — a full multi-turn session through its real CLI hooks — and records what it decided
at every turn.

## Requirements

| | |
|---|---|
| Node | 22 or newer (`node:sqlite` is used to read NexPath's store) |
| Python | 3.8 or newer (gives each run its own terminal, so the popup never touches yours) |
| NexPath | cloned and **built** — `npm install && npm run build`, so `dist/cli/index.js` exists |
| An OpenAI key | only for runs where NexPath's own AI calls should happen |
| Platform | Linux (NexPath draws its popup to `/dev/tty`) |

## Run one session

```bash
# a free check: no key, so NexPath never calls out
node runner/run-session.mjs \
  --task=iterative__dvc_2.19.0_2.20.0 \
  --arm=nexpath \
  --project=/path/to/a/checkout \
  --nexpath-cli=/path/to/nexpath/dist/cli/index.js \
  --no-key
```

With NexPath's AI calls recorded, so a repeat is free and identical:

```bash
node proxy/proxy.mjs --mode=record --port=8787 --name=run1 &

node runner/run-session.mjs \
  --task=iterative__dvc_2.19.0_2.20.0 --arm=nexpath \
  --project=/path/to/a/checkout \
  --nexpath-cli=/path/to/nexpath/dist/cli/index.js \
  --env-file=/path/to/a/file/holding/OPENAI_API_KEY \
  --proxy-url=http://127.0.0.1:8787/v1 --require-proxy-mode=record
```

## Agent driver pilot (experimental)

`runner/agent-driver.mjs` hands the frozen turns-1-and-2 only to a real Claude Code
agent (`claude -p ... --resume ...`), instead of recording decisions with no agent at
all. It supports both arms:

- `arm: control` — each prompt goes straight to the agent; NexPath is never invoked,
  even if `--nexpath-cli` is given.
- `arm: nexpath` — `nexpath auto` (UserPromptSubmit) runs before the agent sees the
  prompt, `nexpath stop` (Stop) runs only once that agent turn has completed, and the
  run gets its own fresh `session.db` under its output dir — never `~/.nexpath`, and
  never the user's Claude Code settings (NexPath is invoked as a plain subprocess, not
  through `nexpath install`).

  When `stop` accepts guidance (the real hook contract: stdout
  `{"decision":"block","reason":...}` on a clean exit), it is delivered to the same
  Claude Code session as a separate continuation turn via `--resume` — the frozen
  prompt in `turns.jsonl` is never rewritten. The continuation's own
  UserPromptSubmit/Stop fire too (Stop with `stop_hook_active:true`, matching Claude
  Code's own loop-guard condition), and the chain is capped by `--max-continuations`
  (default 2) so a build that keeps blocking cannot loop the driver forever — hitting
  the cap is logged and recorded, not hidden. Each continuation's prompt, guidance,
  session id, hook outcome, agent result and patch are recorded in their own row in
  `continuations.jsonl`, separate from the turn's own row in `agent-results.jsonl`.
  A `turns.jsonl` that already carries NexPath's own hook-outcome fields (i.e. one
  `run-session.mjs` already ran through its nexpath arm) is rejected outright, so the
  live driver can never apply NexPath's hooks a second time over the same prompts.

  Every hook call's exit status is checked: a nonzero exit or a timeout-triggered
  signal kill fails the whole run loudly instead of being silently read as "no
  guidance" — a broken or hung NexPath call must never decay a nexpath-arm turn into
  control-arm-like behaviour while the run still reports success. Each hook call is
  also spawned detached from any controlling terminal, so NexPath's popup (which opens
  `/dev/tty` directly) can never attach to the terminal the driver was launched from.

  Each step writes two patches: `<tag>.patch` is the CUMULATIVE diff since the run's
  starting commit (every prior turn/continuation included), and `<tag>-incremental.patch`
  is just that step's own change. Both are built by staging everything (`git add -A`)
  and diffing tree objects, so a file the agent newly *created* (never staged by the
  agent itself) is captured too — a bare `git diff` silently drops untracked files
  entirely.

### Known limitations

- **OS keychain is not sandboxed.** `--no-key` and the `$HOME` sandbox used for every
  nexpath subprocess call keep NexPath from reading `~/.nexpath/config.json`, but
  NexPath's credential resolver also checks the OS keychain (`cross-keychain`), which is
  tied to the login session rather than `$HOME`. On a machine where a real OpenAI key
  was ever stored there (e.g. via `nexpath config set apikey`), a "keyless" run may
  still use it. `meta.json`'s `credential_isolation.keychain_sandboxed` is always
  `false` as a reminder. There is no fix for this available from the harness side
  without changing NexPath's own resolver.
- **The real popup path is still unverified end-to-end.** Detaching the nexpath
  subprocess from any controlling terminal stops it from rendering onto the operator's
  terminal, but it also means a direct-tty popup can never render in that subprocess —
  consistent with a headless/CI run, but not yet exercised against the real built CLI
  with a live agent. Only mocked-CLI runs cover the Stop-hook block/continuation path
  today.

```bash
node runner/agent-driver.mjs --turns=runs/<run-id>/turns.jsonl --project=<checkout> \
  --execute --nexpath-cli=/path/to/nexpath/dist/cli/index.js
```

It validates turns 1-2 only and explicitly rejects anything that doesn't match the
frozen, always-fits entries in `prompts/<task>.json`. See `--help` for every flag.

Then grade the popups it produced:

```bash
node grading/grade-run.mjs --run=<run-id>
```

Every script takes `--help`.

## Layout

| path | what it is |
|---|---|
| `runner/run-session.mjs` | drives one session: the prompts in, the decisions and popups out |
| `runner/pty-run.py` | gives the run its own terminal and answers the popup |
| `proxy/proxy.mjs` | record / replay / auto for NexPath's AI calls |
| `proxy/rekey.mjs` | re-keys an existing cassette without calling the API |
| `grading/GRADING-SHEET.md` | the five yes/no rules for popup text |
| `grading/grade-run.mjs` | applies them, writes `grades.csv` |
| `prompts/<task>.json` | the frozen conversation for a task |
| `HOW-IT-WORKS.md` | the moving parts, in more detail |
| `runs/<id>/turns.jsonl` | what the agent must receive, one row per turn (the handover file) |
| `runs/`, `proxy/cassettes/` | local output — not published |
