#!/usr/bin/env node
// Experimental SWE-EVO agent handoff, restricted to the first two
// unconditional turns (control or nexpath arm). Not an evaluator or a full
// 20-turn driver.
//
// control arm: each frozen prompt goes straight to the agent. NexPath is never invoked.
// nexpath arm: per turn, `nexpath auto` (UserPromptSubmit) runs BEFORE the agent call,
//   and `nexpath stop` (Stop) runs AFTER that agent call completes — matching the real
//   Claude Code hook contract (auto never rewrites the prompt; any enhancement surfaces
//   later, via stop). Both hooks are invoked by full path to a built CLI, against a
//   fresh per-run SQLite file — never ~/.nexpath, never the user's Claude settings.
//   When `stop` accepts guidance (stdout `{"decision":"block","reason":...}`, exit 0 — the
//   real contract in src/cli/commands/stop.ts), it is delivered to the SAME session as a
//   separate continuation turn (`--resume`), never by rewriting the frozen prompt. The
//   continuation's own UserPromptSubmit/Stop fire with `stop_hook_active:true` on the Stop
//   side, and the chain is capped by --max-continuations (default 2) so a NexPath build that
//   keeps blocking can never loop this driver forever; hitting the cap is reported, not hidden.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, '..');

const flags = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [name, ...pieces] = arg.replace(/^--/, '').split('=');
  return [name, pieces.length ? pieces.join('=') : true];
}));
const fail = (reason) => { console.error(`ERROR: ${reason}`); process.exit(2); };
if (flags.help) {
  console.log(`Usage: node runner/agent-driver.mjs --turns=<path> --project=<git-checkout> [options]

Default: validate inputs and print a DRY RUN summary (no model calls).
  --execute                   explicitly run agent calls (uses Claude subscription)
  --out=<dir>                 default: <harness-run>/agent-driver
  --model=<name>              default: claude-sonnet-5
  --max-turns=<n>             per agent response; default: 8
  --timeout-seconds=<n>       per agent response; default: 300
  --agent-bin=<path>          default: claude (replace only for offline tests)

nexpath arm only (arm must be "nexpath" in the harness meta.json)
  --nexpath-cli=<path>        NexPath's built CLI, by full path       [env NEXPATH_CLI]
  --env-file=<path>           file holding OPENAI_API_KEY=...         [env NEXPATH_ENV_FILE]
  --no-key                    withhold the key (keyless condition; costs nothing)
  --nexpath-timeout-seconds=<n> per hook call; default: 60
  --max-continuations=<n>     Stop-hook block decisions delivered per turn; default: 2

Safety/scope: only turns 1-2, clean Git checkout. No shell tool for agent.
This is a handoff pilot; it does not score SWE-EVO or check conditional turns.`);
  process.exit(0);
}
for (const name of ['turns', 'project']) {
  if (typeof flags[name] !== 'string' || !flags[name]) fail(`--${name}=<value> is required`);
}
if (flags.execute && flags.execute !== true) fail('--execute must not have a value');
const turnsFile = resolve(flags.turns);
const project = resolve(flags.project);
const out = resolve(flags.out || join(dirname(turnsFile), 'agent-driver'));
const execute = flags.execute === true;
const model = String(flags.model || 'claude-sonnet-5');
const maxTurns = Number(flags['max-turns'] || 8);
const timeoutSeconds = Number(flags['timeout-seconds'] || 300);
const agentBin = String(flags['agent-bin'] || 'claude');
const nexpathTimeoutSeconds = Number(flags['nexpath-timeout-seconds'] || 60);
const maxContinuations = Number(flags['max-continuations'] ?? 2);
const NEXPATH_CLI = String(flags['nexpath-cli'] ?? process.env.NEXPATH_CLI ?? '');
const ENV_FILE = String(flags['env-file'] ?? process.env.NEXPATH_ENV_FILE ?? '');
const noKey = !!flags['no-key'];
if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) fail('--max-turns must be 1..100');
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) fail('--timeout-seconds must be 1..1800');
if (!Number.isSafeInteger(nexpathTimeoutSeconds) || nexpathTimeoutSeconds < 1 || nexpathTimeoutSeconds > 600) fail('--nexpath-timeout-seconds must be 1..600');
if (!Number.isSafeInteger(maxContinuations) || maxContinuations < 0 || maxContinuations > 10) fail('--max-continuations must be 0..10');
if (!existsSync(turnsFile) || !existsSync(project)) fail('input turns file or project directory is missing');
const metadataFile = join(dirname(turnsFile), 'meta.json');
if (!existsSync(metadataFile)) fail('missing meta.json beside turns.jsonl');

let meta, rows;
try {
  meta = JSON.parse(readFileSync(metadataFile, 'utf8'));
  rows = readFileSync(turnsFile, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
} catch (e) { fail(`invalid harness input: ${e.message}`); }
if (meta.schema !== 'custom_harness.run.v1') fail('pilot requires custom_harness.run.v1 harness metadata');
if (!['control', 'nexpath'].includes(meta.arm)) fail('pilot requires meta.arm of "control" or "nexpath"');
const arm = meta.arm;
if (resolve(meta.project) !== project) fail('project differs from harness metadata');
if (rows.length !== 2 || meta.limit !== 2) fail('pilot requires --limit=2 and exactly two turns');
for (const [i, row] of rows.entries()) {
  if (row.turn !== i + 1 || typeof row.raw_prompt !== 'string') {
    fail(`inconsistent frozen handoff at turn ${i + 1}`);
  }
  if (arm === 'control' && (row.submit !== row.raw_prompt || row.enhanced_used !== false)) {
    fail(`inconsistent frozen control handoff at turn ${i + 1}`);
  }
}

// run-session.mjs's own nexpath-arm rows always carry its hook-outcome fields (set, even when
// null, by its unconditional `appendFileSync` — see runner/run-session.mjs). If this driver's
// nexpath arm then ran its OWN auto/stop calls over the same raw prompts, NexPath would decide
// on the same conversation twice under two different sessions/databases — a silent double
// intervention, not a resume of the first one. Reject rather than let that happen quietly; a
// plain {turn, raw_prompt} handoff (what this driver actually consumes) never has these keys.
if (arm === 'nexpath') {
  const RUN_SESSION_HOOK_OUTCOME_KEYS = ['enhanced_prompt', 'fired_flag', 'pe_status', 'pe_sections', 'keeps_original_verbatim'];
  for (const [i, row] of rows.entries()) {
    const present = RUN_SESSION_HOOK_OUTCOME_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(row, k));
    if (present.length) {
      fail(`turn ${i + 1} already carries NexPath hook-outcome fields (${present.join(', ')}) from run-session.mjs; `
        + `running this driver's nexpath arm on it would invoke NexPath a second time on the same prompts. `
        + `Use run-session.mjs's control-arm output, or a plain {turn, raw_prompt} handoff, for the live agent pilot.`);
    }
  }
}

// Cross-check against the frozen prompt file when it can be found, so a conditional
// turn (one whose "check" depends on transcript/diff state) can never be smuggled in
// as if it were turn 1 or 2. Best-effort: skipped for synthetic/offline task ids that
// have no prompts/<task>.json, so existing pilot fixtures keep working unchanged.
const frozenPath = join(HARNESS, 'prompts', `${meta.task}.json`);
if (existsSync(frozenPath)) {
  let frozen;
  try { frozen = JSON.parse(readFileSync(frozenPath, 'utf8')); } catch (e) { fail(`unreadable frozen prompt file: ${e.message}`); }
  for (const row of rows) {
    const entry = Array.isArray(frozen.prompts) ? frozen.prompts.find((p) => p.n === row.turn) : null;
    if (!entry) fail(`turn ${row.turn} has no matching entry in ${frozenPath}`);
    if (entry.check !== 'always fits') {
      fail(`turn ${row.turn} is a conditional turn ("check": ${JSON.stringify(entry.check)}); this pilot supports only the always-fits turns 1-2`);
    }
    if (entry.text !== row.raw_prompt) {
      fail(`turn ${row.turn} prompt text does not match the frozen entry for task ${meta.task} (pilot only supports the frozen, always-fits turns 1-2)`);
    }
  }
}

if (arm === 'nexpath') {
  if (!NEXPATH_CLI) fail('nexpath arm requires --nexpath-cli=<path> (or NEXPATH_CLI env var)');
  if (!existsSync(NEXPATH_CLI)) fail(`NexPath CLI not found at ${NEXPATH_CLI}`);
}

const git = (...args) => {
  const res = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.error || res.status !== 0) fail(`git ${args.join(' ')} failed: ${res.error?.message || res.stderr?.trim()}`);
  return res.stdout;
};
const startingCommit = git('rev-parse', 'HEAD').trim();
if (git('status', '--porcelain').trim()) fail('Git worktree must be clean before first turn');
console.log(`Validated ${arm} turns [1, 2] at ${startingCommit.slice(0, 12)}; ${execute ? 'EXECUTE' : 'DRY RUN'}`);
if (!execute) {
  for (const row of rows) console.log(`turn ${row.turn}: ${row.raw_prompt.length} characters`);
  console.log('DRY RUN PASS: no agent or NexPath launched; no output files written');
  process.exit(0);
}
if (existsSync(out)) fail(`output directory already exists: ${out}; refusing to overwrite`);
mkdirSync(out, { recursive: true });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ── nexpath hook isolation ───────────────────────────────────────────────────
// One fresh SQLite file per RUN, under this run's own output directory. NexPath's
// config table lives inside this same file, so pointing --db here is sufficient to
// keep the run's prompts, advisories and config away from ~/.nexpath entirely.
// NexPath is invoked as a plain subprocess (never through `nexpath install`), so
// the user's Claude Code settings are never touched either.
const dbPath = join(out, 'session.db');
function keyFromEnvFile() {
  if (process.env.OPENAI_API_KEY) return { key: process.env.OPENAI_API_KEY, from: 'environment' };
  if (!ENV_FILE || !existsSync(ENV_FILE)) return { key: undefined, from: 'missing' };
  const line = readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('OPENAI_API_KEY='));
  return { key: line ? line.slice('OPENAI_API_KEY='.length).trim() : undefined, from: line ? 'env file' : 'missing' };
}
const { key, from: keyFrom } = noKey ? { key: undefined, from: 'withheld (--no-key)' } : keyFromEnvFile();

// resolveOpenAIKey()'s fallback chain (src/config/ApiKeyResolver.ts) is NOT scoped by --db or
// by this process's env: after env + the project's own .env, it falls through to the OS
// keychain, then a 0600 file at `join(homedir(), '.nexpath', 'config.json')`, then a stored
// Nexpath token — all read inside the nexpath subprocess regardless of what key (if any) we
// pass it. On a machine where NexPath was ever configured with a real key, that means --no-key
// does NOT actually withhold it: the subprocess finds it anyway via homedir(). Pointing HOME at
// an empty, run-local, never-populated directory keeps the FILE fallback layer (and any other
// homedir()-keyed state) from ever reaching the operator's real ~/.nexpath. The OS keychain
// layer (`cross-keychain`) is tied to the login session, not $HOME, so it is NOT sandboxed by
// this — see README "Known limitations". We never read this directory ourselves.
const nexpathHome = join(out, 'nexpath-home');
if (arm === 'nexpath') mkdirSync(nexpathHome, { recursive: true }); // control arm never spawns nexpath; nothing to sandbox
const nexpathEnv = { ...process.env, HOME: nexpathHome };
if (key) nexpathEnv.OPENAI_API_KEY = key; else delete nexpathEnv.OPENAI_API_KEY;

function callNexpathHook(cmdArgs, stdinPayload, tag) {
  const startedAt = new Date().toISOString();
  const res = spawnSync(process.execPath, [NEXPATH_CLI, ...cmdArgs], {
    cwd: project, env: nexpathEnv, encoding: 'utf8',
    input: JSON.stringify(stdinPayload), timeout: nexpathTimeoutSeconds * 1000,
    maxBuffer: 16 * 1024 * 1024,
    // NexPath's PE/advisory popup opens /dev/tty directly (the CONTROLLING terminal, not fd
    // 0/1/2) whenever one is reachable (src/cli/prompt-enhancement-host.ts probeDirectTty) —
    // so without this, running the driver from an interactive shell lets the Stop hook render
    // its popup straight onto the operator's own terminal while nothing here presses a key for
    // it. `detached: true` makes this child the leader of its own session (POSIX setsid
    // semantics), so it starts with NO controlling terminal at all and /dev/tty reliably fails
    // closed (ENXIO) instead of attaching to ours. Matches what run-session.mjs's pty-run.py
    // wrapper exists to prevent, by denying any ctty rather than supplying an isolated one.
    detached: true,
  });
  // spawnSync's own `timeout` kill DOES surface as `res.error` (ETIMEDOUT) on current Node, so
  // it is already caught by the check just below. What it does NOT cover is a kill delivered by
  // something OTHER than that timeout — an OOM-killer, a crash that raises SIGSEGV/SIGABRT, or
  // the operator sending a signal by hand — which reports only `res.signal` (status null, no
  // `error`). Checked explicitly below so that case can never be read as a clean "no guidance".
  if (res.error) fail(`nexpath ${cmdArgs[0]} failed to spawn: ${res.error.message}`);
  writeFileSync(join(out, `${tag}-stdout.log`), res.stdout || '');
  writeFileSync(join(out, `${tag}-stderr.log`), res.stderr || '');
  const row = { hook: cmdArgs[0], tag, started_at: startedAt, exit_code: res.status, signal: res.signal };
  appendFileSync(join(out, 'nexpath-hooks.jsonl'), JSON.stringify(row) + '\n');
  // The real hook (src/cli/commands/{auto,stop}.ts) exits 0 on every outcome it recognises —
  // "no action", blocked, shown, dismissed, even a missing key — so a nonzero exit or an
  // unexplained signal kill means the hook crashed, hung, or was killed mid-run, never a
  // legitimate "no guidance". Treating that as benign would let a broken nexpath call silently
  // decay a nexpath-arm turn into control-arm-like behaviour while the run still reports success.
  if (res.signal) {
    fail(`nexpath ${cmdArgs[0]} (${tag}) was killed by signal ${res.signal} — likely exceeded `
      + `--nexpath-timeout-seconds=${nexpathTimeoutSeconds}; inspect ${tag}-stderr.log in ${out}`);
  }
  if (res.status !== 0) {
    fail(`nexpath ${cmdArgs[0]} (${tag}) exited with status ${res.status}; inspect ${tag}-stderr.log in ${out}`);
  }
  return res;
}

writeFileSync(join(out, 'meta.json'), JSON.stringify({
  schema: arm === 'control' ? 'agent_driver.control_pilot.v1' : 'agent_driver.nexpath_pilot.v1',
  task: meta.task, arm, starting_commit: startingCommit,
  model, max_turns: maxTurns, timeout_seconds: timeoutSeconds,
  source: turnsFile, source_sha256: sha256(readFileSync(turnsFile)),
  mode: 'first_two_unconditional_turns_only',
  ...(arm === 'nexpath' ? {
    nexpath_cli: NEXPATH_CLI, db: dbPath,
    key_source: keyFrom === 'missing' ? 'none' : keyFrom,   // never the key itself
    nexpath_timeout_seconds: nexpathTimeoutSeconds,
    // home_sandboxed: the file-fallback credential layer (~/.nexpath/config.json) cannot reach
    // the real home directory for this run. keychain_sandboxed is always false: the OS keychain
    // layer is tied to the login session, not $HOME, and cannot be sandboxed from here — a run
    // on a machine with a keychain-stored key may still use it even under --no-key.
    credential_isolation: { home_sandboxed: true, nexpath_home: nexpathHome, keychain_sandboxed: false },
  } : {}),
  started_at: new Date().toISOString(),
}, null, 2) + '\n');

// ── agent + Stop-hook-decision helpers ──────────────────────────────────────────
function runAgent(prompt, resume) {
  const args = [
    '-p', prompt, '--model', model,
    '--permission-mode', 'acceptEdits',
    '--tools', 'Read,Glob,Grep,Edit,Write',
    '--max-turns', String(maxTurns), '--output-format', 'json',
  ];
  if (resume) args.push('--resume', resume);
  const agentEnv = { ...process.env };
  delete agentEnv.ANTHROPIC_API_KEY; // avoid silently using separately billed Anthropic API keys
  const res = spawnSync(agentBin, args, {
    cwd: project, env: agentEnv, encoding: 'utf8', timeout: timeoutSeconds * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  let parsed = {};
  try { parsed = JSON.parse(res.stdout); } catch { /* store raw stdout for diagnosis */ }
  const returnedSession = typeof parsed.session_id === 'string' ? parsed.session_id : null;
  return { res, parsed, returnedSession };
}

// Diffed against on the FIRST step; reassigned to each step's tree after, so
// `${tag}-incremental.patch` always holds exactly what that step itself changed.
let previousTreeSha = startingCommit;
function writeStepArtifacts(tag, res) {
  writeFileSync(join(out, `${tag}-stdout.json`), res.stdout || '');
  writeFileSync(join(out, `${tag}-stderr.log`), res.stderr || '');
  // Plain `git diff` (no args) compares the working tree to the INDEX — a file the agent
  // CREATED but never `git add`ed never appears, not even its filename, let alone content;
  // git-status.txt would show it as `??` while the patch silently dropped it entirely. Stage
  // everything first (git add -A still honours .gitignore) and diff TREE objects instead:
  // `git write-tree` serialises the index with no commit and no author identity required, so
  // this works even in a checkout with no git user configured.
  git('add', '-A');
  const treeSha = git('write-tree').trim();
  // `${tag}.patch` stays the CUMULATIVE diff since the run's starting commit (every prior
  // step's edits included) — unchanged in meaning from before, just now complete. The new
  // `${tag}-incremental.patch` is what THIS step alone changed; without it, every patch after
  // the first silently included all earlier turns'/continuations' edits as if they were new.
  const cumulativeDiff = git('diff', '--binary', startingCommit, treeSha);
  const incrementalDiff = git('diff', '--binary', previousTreeSha, treeSha);
  writeFileSync(join(out, `${tag}.patch`), cumulativeDiff);
  writeFileSync(join(out, `${tag}-incremental.patch`), incrementalDiff);
  writeFileSync(join(out, `${tag}-git-status.txt`), git('status', '--short'));
  previousTreeSha = treeSha;
  return { cumulativeDiff, incrementalDiff };
}

// The real Stop hook (src/cli/commands/stop.ts) prints `{"decision":"block","reason":...}` to
// stdout and exits 0 ONLY when it is delivering accepted guidance as the next Claude turn;
// every other outcome (no pending advisory, feedback shown, dismissed, disabled, ...) exits 0
// with no such line, which Claude Code reads as "stop normally". Mirror that exactly: absence
// of a decision line is "no guidance" (never a failure), and a decision line that does not match
// the real shape is "malformed" — reported, but never treated as accepted.
function parseStopDecision(stdout) {
  const jsonLine = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).reverse()
    .find((l) => l.startsWith('{'));
  if (!jsonLine) return { kind: 'none' };
  let obj;
  try { obj = JSON.parse(jsonLine); } catch (e) { return { kind: 'malformed', detail: `stop hook stdout is not valid JSON: ${e.message}` }; }
  if (obj === null || typeof obj !== 'object' || !('decision' in obj)) return { kind: 'none' };
  if (obj.decision !== 'block') return { kind: 'malformed', detail: `unexpected decision value: ${JSON.stringify(obj.decision)}` };
  if (typeof obj.reason !== 'string' || !obj.reason.trim()) return { kind: 'malformed', detail: 'decision "block" without a non-empty string reason' };
  return { kind: 'accepted', reason: obj.reason };
}

let sessionId = null;
for (const row of rows) {
  const prefix = `turn-${String(row.turn).padStart(2, '0')}`;

  if (arm === 'nexpath') {
    // UserPromptSubmit — before the agent ever sees this turn's prompt. Per the real
    // hook contract, `auto` never rewrites the prompt; it only classifies/records.
    callNexpathHook(['auto', '-p', project, '--db', dbPath],
      { prompt: row.raw_prompt, permission_mode: 'bypassPermissions' }, `${prefix}-auto`);
  }

  const { res, parsed, returnedSession } = runAgent(row.raw_prompt, sessionId);
  const { cumulativeDiff, incrementalDiff } = writeStepArtifacts(prefix, res);

  let stopDecision = { kind: 'none' };
  if (arm === 'nexpath') {
    // Stop — only once this agent turn has actually completed (success or failure).
    const stopRes = callNexpathHook(['stop', '--db', dbPath], {
      cwd: project, hook_event_name: 'Stop', stop_hook_active: false,
      session_id: returnedSession ?? sessionId ?? null,
      ...(typeof parsed.result === 'string' ? { last_assistant_message: parsed.result } : {}),
    }, `${prefix}-stop`);
    stopDecision = parseStopDecision(stopRes.stdout);
  }

  const rowResult = {
    turn: row.turn, prompt_sha256: sha256(row.raw_prompt),
    exit_code: res.status, signal: res.signal, process_error: res.error?.message || null,
    is_error: parsed.is_error ?? null, subtype: parsed.subtype ?? null,
    session_id: returnedSession, num_turns: parsed.num_turns ?? null,
    continuations: 0, continuation_limit_reached: false,
    patch_file: `${prefix}.patch`, patch_bytes: Buffer.byteLength(cumulativeDiff),
    incremental_patch_file: `${prefix}-incremental.patch`, incremental_patch_bytes: Buffer.byteLength(incrementalDiff),
  };
  console.log(`turn ${row.turn}: exit=${res.status} status=${parsed.subtype || 'unknown'} `
    + `patch=${rowResult.patch_bytes} bytes (own change: ${rowResult.incremental_patch_bytes} bytes)`);
  if (res.error || res.status !== 0 || parsed.is_error !== false || !returnedSession || (sessionId && returnedSession !== sessionId)) {
    appendFileSync(join(out, 'agent-results.jsonl'), JSON.stringify(rowResult) + '\n');
    fail(`agent turn ${row.turn} failed; inspect artifacts in ${out}`);
  }
  sessionId = returnedSession;

  // ── nexpath arm only: deliver an accepted Stop-hook decision as a bounded chain of
  // continuations on the SAME Claude Code session. The frozen prompt recorded for this turn
  // (row.raw_prompt, already sent above) is never replaced — the guidance is a separate,
  // later turn, exactly as Claude Code's own `{decision:"block",reason}` handling delivers it.
  let step = 0;
  let pendingDecision = stopDecision;
  let continuationLimitReached = false;
  while (arm === 'nexpath' && pendingDecision.kind === 'accepted') {
    if (step >= maxContinuations) { continuationLimitReached = true; break; }
    step += 1;
    const contPrefix = `${prefix}-cont-${String(step).padStart(2, '0')}`;
    const guidance = pendingDecision.reason;

    // UserPromptSubmit for the injected turn, exactly as Claude Code fires it for a block
    // decision's continuation. In a real build NexPath's own echo guard (isInjectedPromptEcho,
    // src/decision-session/whydesc-delivery.ts) is what recognises this text came from its own
    // Stop hook and skips re-processing it as a fresh user prompt; offline tests mock that call.
    callNexpathHook(['auto', '-p', project, '--db', dbPath],
      { prompt: guidance, permission_mode: 'bypassPermissions' }, `${contPrefix}-auto`);

    const contCall = runAgent(guidance, sessionId);
    const { cumulativeDiff: contCumulativeDiff, incrementalDiff: contIncrementalDiff } = writeStepArtifacts(contPrefix, contCall.res);

    // Stop fires with stop_hook_active:true — Claude is continuing BECAUSE of the previous
    // block, which is precisely the condition the real hook's loop guard (runStop step 1,
    // src/cli/commands/stop.ts) checks for.
    const contStopRes = callNexpathHook(['stop', '--db', dbPath], {
      cwd: project, hook_event_name: 'Stop', stop_hook_active: true,
      session_id: contCall.returnedSession ?? sessionId ?? null,
      ...(typeof contCall.parsed.result === 'string' ? { last_assistant_message: contCall.parsed.result } : {}),
    }, `${contPrefix}-stop`);
    const contDecision = parseStopDecision(contStopRes.stdout);

    // Recorded separately from the turn's own row: the original prompt, the injected guidance,
    // the session id, the hook outcome, and the agent's execution result each get their own
    // field here, and the patch for this step is its own file (never folded into the turn's).
    appendFileSync(join(out, 'continuations.jsonl'), JSON.stringify({
      turn: row.turn, step,
      original_prompt_sha256: sha256(row.raw_prompt),
      injected_guidance: guidance, injected_guidance_sha256: sha256(guidance),
      session_id: contCall.returnedSession,
      exit_code: contCall.res.status, signal: contCall.res.signal,
      process_error: contCall.res.error?.message || null,
      is_error: contCall.parsed.is_error ?? null, subtype: contCall.parsed.subtype ?? null,
      hook_outcome: contDecision.kind,
      hook_reason: contDecision.kind === 'accepted' ? contDecision.reason : null,
      hook_detail: contDecision.kind === 'malformed' ? contDecision.detail : null,
      patch_file: `${contPrefix}.patch`, patch_bytes: Buffer.byteLength(contCumulativeDiff),
      incremental_patch_file: `${contPrefix}-incremental.patch`,
      incremental_patch_bytes: Buffer.byteLength(contIncrementalDiff),
    }) + '\n');
    console.log(`  turn ${row.turn} continuation ${step}: exit=${contCall.res.status} hook=${contDecision.kind}`);

    if (contCall.res.error || contCall.res.status !== 0 || contCall.parsed.is_error !== false
      || !contCall.returnedSession || contCall.returnedSession !== sessionId) {
      rowResult.continuations = step;
      appendFileSync(join(out, 'agent-results.jsonl'), JSON.stringify(rowResult) + '\n');
      fail(`agent turn ${row.turn} continuation ${step} failed; inspect artifacts in ${out}`);
    }
    sessionId = contCall.returnedSession;
    pendingDecision = contDecision;
  }
  if (pendingDecision.kind === 'malformed') {
    console.log(`turn ${row.turn}: WARNING — ignoring malformed Stop-hook decision (${pendingDecision.detail})`);
  }
  if (continuationLimitReached) {
    console.log(`turn ${row.turn}: CONTINUATION LIMIT REACHED (${maxContinuations}) — further guidance was not delivered`);
  }
  rowResult.continuations = step;
  rowResult.continuation_limit_reached = continuationLimitReached;
  appendFileSync(join(out, 'agent-results.jsonl'), JSON.stringify(rowResult) + '\n');
}
console.log(`${arm.toUpperCase()} PILOT COMPLETE (NOT SCORED): ${out}`);
