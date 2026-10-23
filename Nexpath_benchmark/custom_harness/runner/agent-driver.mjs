#!/usr/bin/env node
// Agent driver for a complete, ordered frozen SWE-EVO conversation.
// This pilot does not score the benchmark.
// Control prompts go directly to Claude Code.
// Standalone NexPath runs call UserPromptSubmit and Stop; processed runner
// handoffs deliver accepted prompts without calling those hooks again.
// Accepted standalone Stop guidance resumes the session in bounded continuations.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, '..');
const PTY_RUN = join(HERE, 'pty-run.py');
const PYTHON = process.env.HARNESS_PYTHON || 'python3';
const POPUP_MARKER = 'Enter sends this prompt';
// Capture the real home before giving NexPath hooks their isolated HOME.
const realHome = homedir();

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
  --from-runner               fixture-only input; not a measured NexPath arm
  --level=<name>              optimum (default) or every_event; others: off, major_only, once_per_session
  --proxy-url=<url>           NexPath record/replay proxy
  --require-proxy-mode=<m>   verify proxy mode before the run

nexpath arm only (arm must be "nexpath" in the harness meta.json)
  --nexpath-cli=<path>        NexPath's built CLI, by full path       [env NEXPATH_CLI]
  --env-file=<path>           file holding OPENAI_API_KEY=...         [env NEXPATH_ENV_FILE]
  --no-key                    withhold the key (keyless condition; costs nothing)
  --nexpath-timeout-seconds=<n> per hook call; default: 60
  --max-continuations=<n>     Stop-hook block decisions delivered per turn; default: 2

Safety/scope: full frozen prompt order, clean Git checkout, no shell tool for agent.
Conditional turns are sent in order and are not used as scores.`);
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
if (flags['from-runner'] && flags['from-runner'] !== true) fail('--from-runner must not have a value');
const fromRunner = flags['from-runner'] === true;
const model = String(flags.model || 'claude-sonnet-5');
const maxTurns = Number(flags['max-turns'] || 8);
const timeoutSeconds = Number(flags['timeout-seconds'] || 300);
const agentBin = String(flags['agent-bin'] || 'claude');
const nexpathTimeoutSeconds = Number(flags['nexpath-timeout-seconds'] || 60);
const maxContinuations = Number(flags['max-continuations'] ?? 2);
const NEXPATH_CLI = String(flags['nexpath-cli'] ?? process.env.NEXPATH_CLI ?? '');
const ENV_FILE = String(flags['env-file'] ?? process.env.NEXPATH_ENV_FILE ?? '');
const noKey = !!flags['no-key'];
const level = String(flags.level || 'optimum');
if (!['optimum', 'every_event', 'off', 'major_only', 'once_per_session'].includes(level)) {
  fail('invalid --level; expected optimum, every_event, off, major_only, or once_per_session');
}
const proxyUrl = flags['proxy-url'] === undefined ? '' : String(flags['proxy-url']);
const requiredProxyMode = flags['require-proxy-mode'] === undefined ? '' : String(flags['require-proxy-mode']);
if (requiredProxyMode && !['record', 'replay', 'auto'].includes(requiredProxyMode)) fail('invalid --require-proxy-mode');
if (requiredProxyMode && !proxyUrl) fail('--require-proxy-mode requires --proxy-url');
if (proxyUrl && !/^https?:\/\//.test(proxyUrl)) fail('--proxy-url must use http:// or https://');
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
if (fromRunner && arm !== 'nexpath') fail('--from-runner is only valid for a NexPath handoff');
if (resolve(meta.project) !== project) fail('project differs from harness metadata');
if (!rows.length) fail('frozen turn list is empty');
for (const [i, row] of rows.entries()) {
  if (row.turn !== i + 1 || typeof row.raw_prompt !== 'string') {
    fail(`inconsistent frozen handoff at turn ${i + 1}`);
  }
  if (arm === 'control' && (row.submit !== row.raw_prompt || row.enhanced_used !== false)) {
    fail(`inconsistent frozen control handoff at turn ${i + 1}`);
  }
}

// A harness-generated NexPath row already contains its accepted prompt in 'submit'.
// Consuming it must not trigger the same hooks a second time.
const hookFields = ['enhanced_prompt', 'fired_flag', 'pe_status', 'pe_sections', 'keeps_original_verbatim'];
const hasHookFields = (row) => hookFields.some((field) => Object.hasOwn(row, field));
const preprocessedNexpath = arm === 'nexpath' && fromRunner;
if (arm === 'nexpath' && !fromRunner && rows.some(hasHookFields)) {
  fail('processed NexPath handoff requires --from-runner (fixture only)');
}
if (fromRunner && !rows.some(hasHookFields)) {
  fail('--from-runner requires processed NexPath rows with hook-outcome fields');
}
if (preprocessedNexpath) {
  for (const [i, row] of rows.entries()) {
    if (!hookFields.every((field) => Object.hasOwn(row, field))) {
      fail('turn ' + (i + 1) + ' has incomplete NexPath hook outcome fields');
    }
    if (typeof row.submit !== 'string' || !row.submit.trim()
      || typeof row.enhanced_used !== 'boolean'
      || (row.enhanced_prompt !== null && typeof row.enhanced_prompt !== 'string')
      || row.submit !== (row.enhanced_prompt ?? row.raw_prompt)
      || row.enhanced_used !== Boolean(row.enhanced_prompt)
      || row.keeps_original_verbatim === false) {
      fail('turn ' + (i + 1) + ' has inconsistent accepted NexPath handoff');
    }
  }
}

// A real benchmark run must contain every frozen prompt in order. The
// synthetic-only fixtures without a prompt file retain their smaller test inputs.
const frozenPath = join(HARNESS, 'prompts', `${meta.task}.json`);
let frozenEntries = null;
if (existsSync(frozenPath)) {
  let frozen;
  try { frozen = JSON.parse(readFileSync(frozenPath, 'utf8')); }
  catch (e) { fail(`unreadable frozen prompt file: ${e.message}`); }
  if (!Array.isArray(frozen.prompts) || frozen.prompts.length === 0) {
    fail('frozen prompt file has no prompt list');
  }
  frozenEntries = frozen.prompts;
  for (const row of rows) {
    const entry = frozenEntries[row.turn - 1];
    if (!entry || entry.n !== row.turn) {
      fail(`turn ${row.turn} has no matching entry in ${frozenPath}`);
    }
    if (entry.text !== row.raw_prompt) {
      fail(`turn ${row.turn} prompt text does not match the frozen entry for task ${meta.task}`);
    }
  }
  if (rows.length !== frozenEntries.length || (meta.limit != null && meta.limit !== frozenEntries.length)) {
    fail(`full frozen session requires all ${frozenEntries.length} prompts in order; got ${rows.length} rows (limit=${meta.limit ?? 'none'})`);
  }
}

if (arm === 'nexpath' && !preprocessedNexpath) {
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
console.log(`Validated ${arm} turns [1..${rows.length}] at ${startingCommit.slice(0, 12)}; ${execute ? 'EXECUTE' : 'DRY RUN'}`);
if (!execute) {
  for (const row of rows) console.log(`turn ${row.turn}: ${row.raw_prompt.length} characters`);
  console.log('DRY RUN PASS: no agent or NexPath launched; no output files written');
  process.exit(0);
}
let actualProxyMode = null;
if (proxyUrl) {
  const statusUrl = proxyUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/__harness/status';
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const status = await response.json();
    if (!['record', 'replay', 'auto'].includes(status.mode)) throw new Error('invalid proxy mode');
    actualProxyMode = status.mode;
  } catch (error) {
    fail('no valid harness proxy answering at ' + statusUrl + ': ' + error.message);
  }
  if (requiredProxyMode && actualProxyMode !== requiredProxyMode) {
    fail('proxy mode is "' + actualProxyMode + '" but --require-proxy-mode=' + requiredProxyMode);
  }
}
if (existsSync(out)) fail(`output directory already exists: ${out}; refusing to overwrite`);
mkdirSync(out, { recursive: true });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// NexPath hook isolation
// One fresh SQLite file per RUN, under this run's own output directory. NexPath's
// config table lives inside this same file, so pointing --db here is sufficient to
// keep the run's prompts, advisories and config away from ~/.nexpath entirely.
// NexPath is invoked as a plain subprocess (never through `nexpath install`), so
// the user's Claude Code settings are never touched either.
const dbPath = join(out, 'session.db');
// Seed the fresh run DB before the first hook without touching global settings.
// NexPath's own store initialization subsequently creates its remaining tables.
if (arm === 'nexpath' && !preprocessedNexpath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO config(key, value) VALUES (?, ?)').run('advisory_frequency', level);
  } finally { db.close(); }
}
function readLevel() {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare("SELECT value FROM config WHERE key = 'advisory_frequency'").get()?.value ?? null; }
  finally { db.close(); }
}

function keyFromEnvFile() {
  if (process.env.OPENAI_API_KEY) return { key: process.env.OPENAI_API_KEY, from: 'environment' };
  if (!ENV_FILE || !existsSync(ENV_FILE)) return { key: undefined, from: 'missing' };
  const line = readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('OPENAI_API_KEY='));
  return { key: line ? line.slice('OPENAI_API_KEY='.length).trim() : undefined, from: line ? 'env file' : 'missing' };
}
const { key, from: keyFrom } = noKey ? { key: undefined, from: 'withheld (--no-key)' } : keyFromEnvFile();

// NexPath can read credentials from the environment, config files, and OS keychain.
// Set a fresh HOME to isolate ~/.nexpath/config.json for hook subprocesses.
// OS-keychain access is not isolated, so --no-key is not a full credential sandbox.
const nexpathHome = join(out, 'nexpath-home');
if (arm === 'nexpath' && !preprocessedNexpath) mkdirSync(nexpathHome, { recursive: true }); // control arm never spawns nexpath; nothing to sandbox
const nexpathEnv = { ...process.env, HOME: nexpathHome };
if (key) nexpathEnv.OPENAI_API_KEY = key; else delete nexpathEnv.OPENAI_API_KEY;
if (proxyUrl) nexpathEnv.OPENAI_BASE_URL = proxyUrl;

// Claude Code stores session transcripts beneath its project slug. Never derive
// the slug from cwd: find the actual file by its returned session id.
function transcriptForSession(sessionId) {
  if (!sessionId) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) fail('unexpected Claude Code session id for transcript lookup');
  const projectsDir = join(realHome, '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;
  const matches = readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsDir, entry.name, sessionId + '.jsonl'))
    .filter((candidate) => existsSync(candidate));
  if (matches.length > 1) fail('ambiguous Claude Code transcript for session ' + sessionId);
  return matches[0] ?? null;
}
function autoPayload(prompt, activeSessionId) {
  const payload = { prompt, permission_mode: 'bypassPermissions' };
  if (activeSessionId) {
    const transcriptPath = transcriptForSession(activeSessionId);
    if (!transcriptPath && /(^|[\\/])claude(?:\.cmd|\.exe)?$/.test(agentBin)) {
      fail('Claude Code transcript not found for session ' + activeSessionId);
    }
    if (transcriptPath) payload.transcript_path = transcriptPath;
  }
  return payload;
}

function callNexpathHook(cmdArgs, stdinPayload, tag) {
  const startedAt = new Date().toISOString();
  const res = spawnSync(PYTHON, [
    PTY_RUN, '--marker=' + POPUP_MARKER, '--quiet-ms=2000',
    '--timeout=' + nexpathTimeoutSeconds,
    '--tty-log=' + join(out, tag + '-tty.log'),
    '--', process.execPath, NEXPATH_CLI, ...cmdArgs,
  ], {
    cwd: project, env: nexpathEnv, encoding: 'utf8',
    input: JSON.stringify(stdinPayload), timeout: (nexpathTimeoutSeconds + 5) * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  // spawnSync reports its timeout through res.error. External signals
  // can appear only in res.signal.
  if (res.error) fail(`nexpath ${cmdArgs[0]} failed to spawn: ${res.error.message}`);
  writeFileSync(join(out, `${tag}-stdout.log`), res.stdout || '');
  writeFileSync(join(out, `${tag}-stderr.log`), res.stderr || '');
  const row = { hook: cmdArgs[0], tag, started_at: startedAt, exit_code: res.status, signal: res.signal };
  appendFileSync(join(out, 'nexpath-hooks.jsonl'), JSON.stringify(row) + '\n');
  // Exit code 0 includes handled no-guidance outcomes; signals and
  // nonzero exits indicate hook failure.
  if (res.signal) {
    fail(`nexpath ${cmdArgs[0]} (${tag}) was killed by signal ${res.signal}; possibly exceeded `
      + `--nexpath-timeout-seconds=${nexpathTimeoutSeconds}; inspect ${tag}-stderr.log in ${out}`);
  }
  if ((res.stderr || '').includes('pty-run: timeout')) {
    fail('nexpath ' + cmdArgs[0] + ' (' + tag + ') timed out after ' + nexpathTimeoutSeconds + 's');
  }
  if (res.status !== 0) {
    const signalMatch = (res.stderr || '').match(/pty-run: exit=(-\d+)/);
    const signalName = signalMatch?.[1] === '-15' ? 'SIGTERM' : signalMatch?.[1] === '-9' ? 'SIGKILL' : null;
    if (signalName) fail('nexpath ' + cmdArgs[0] + ' (' + tag + ') was killed by signal ' + signalName);
    fail('nexpath ' + cmdArgs[0] + ' (' + tag + ') exited with status ' + res.status + '; see ' + tag + '-stderr.log');
  }
  return res;
}

function versionOfNexpath() {
  if (arm !== 'nexpath' || preprocessedNexpath) return null;
  const root = resolve(dirname(NEXPATH_CLI), '..', '..');
  let version = null, commit = null, dirty = null;
  try {
    const pkg = join(root, 'package.json');
    if (existsSync(pkg)) version = JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
  } catch { /* unavailable, not guessed */ }
  const gitCall = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const h = gitCall(['rev-parse', 'HEAD']);
  if (h.status === 0) {
    commit = h.stdout.trim();
    const st = gitCall(['status', '--porcelain']);
    if (st.status === 0) dirty = Boolean(st.stdout.trim());
  }
  return { version, git_commit: commit, git_dirty: dirty };
}
function cliVersion() {
  if (!/(^|[\\/])claude(?:\\.cmd|\\.exe)?$/.test(agentBin)) return null;
  const r = spawnSync(agentBin, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

writeFileSync(join(out, 'meta.json'), JSON.stringify({
  schema: arm === 'control' ? 'agent_driver.control_pilot.v1' : 'agent_driver.nexpath_pilot.v1',
  task: meta.task, arm,
  arm_definition: fromRunner ? 'fixture' : arm === 'nexpath' ? 'standalone' : 'control',
  starting_commit: startingCommit,
  model, max_turns: maxTurns, timeout_seconds: timeoutSeconds,
  claude_cli_version: cliVersion(),
  setting_sources: '',
  setting_sources_argv: ['--setting-sources', ''],
  level: arm === 'nexpath' && !preprocessedNexpath ? level : null,
  advisory_frequency: arm === 'nexpath' && !preprocessedNexpath ? readLevel() : null,
  nexpath_build: versionOfNexpath(),
  source: turnsFile, source_sha256: sha256(readFileSync(turnsFile)),
  proxy: proxyUrl || meta.proxy || null,
  proxy_mode: actualProxyMode || meta.proxy_mode || null,
  required_proxy_mode: requiredProxyMode || null,
  mode: frozenEntries ? 'complete_frozen_session' : 'synthetic_fixture',
  frozen_prompts: frozenEntries?.length ?? null,
  ...(arm === 'nexpath' ? {
    nexpath_cli: NEXPATH_CLI || meta.nexpath_cli || null,
    db: preprocessedNexpath ? (meta.db ?? null) : dbPath,
    hook_source: preprocessedNexpath ? 'run-session' : 'agent-driver',
    key_source: keyFrom === 'missing' ? 'none' : keyFrom,   // never the key itself
    nexpath_timeout_seconds: nexpathTimeoutSeconds,
    // home_sandboxed: the file-fallback credential layer (~/.nexpath/config.json) cannot reach
    // the real home directory for this run. keychain_sandboxed is always false: the OS keychain
    // layer is tied to the login session, not $HOME; a run
    // on a machine with a keychain-stored key may still use it even under --no-key.
    credential_isolation: { home_sandboxed: !preprocessedNexpath, nexpath_home: preprocessedNexpath ? null : nexpathHome, keychain_sandboxed: false },
    popup_input: preprocessedNexpath ? 'accepted by run-session' : 'private PTY auto-Enter',
  } : {}),
  started_at: new Date().toISOString(),
}, null, 2) + '\n');

// Agent and Stop-hook helpers
let previousCumulativeCost = 0;
function agentMetrics(parsed) {
  const total = typeof parsed.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd)
    ? parsed.total_cost_usd : null;
  const delta = total === null ? null : total - previousCumulativeCost;
  if (total !== null) previousCumulativeCost = total;
  const raw = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : {};
  const token = (key) => Number.isFinite(raw[key]) ? raw[key] : null;
  return {
    total_cost_usd: total, cost_delta_usd: delta,
    usage: {
      input_tokens: token('input_tokens'), output_tokens: token('output_tokens'),
      cache_read_input_tokens: token('cache_read_input_tokens'),
      cache_creation_input_tokens: token('cache_creation_input_tokens'),
    },
    duration_ms: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null,
  };
}
function runAgent(prompt, resume) {
  const args = [
    '-p', prompt, '--model', model,
    '--permission-mode', 'acceptEdits', '--setting-sources', '',
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
  // Stage changes before building patches to include newly created files.
  // Compare Git trees without creating a commit.
  git('add', '-A');
  const treeSha = git('write-tree').trim();
  // Record both the cumulative patch since the starting commit and
  // the incremental patch for this step.
  const cumulativeDiff = git('diff', '--binary', startingCommit, treeSha);
  const incrementalDiff = git('diff', '--binary', previousTreeSha, treeSha);
  writeFileSync(join(out, `${tag}.patch`), cumulativeDiff);
  writeFileSync(join(out, `${tag}-incremental.patch`), incrementalDiff);
  writeFileSync(join(out, `${tag}-git-status.txt`), git('status', '--short'));
  // Preserve the on-disk edits while returning Git's index to its original state.
  // The checkout may still be dirty and must be reset separately before reuse.
  git('reset', '--mixed', '--quiet', startingCommit);
  previousTreeSha = treeSha;
  return { cumulativeDiff, incrementalDiff };
}

// A dismissed UserPromptSubmit popup blocks the prompt and suppresses its
// original text. Never interpret that decision as permission to send raw input.
function blockFromAuto(stdout) {
  for (const line of String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).reverse()) {
    if (!line.startsWith('{') || !line.includes('"decision"')) continue;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch (error) { fail('malformed UserPromptSubmit decision JSON: ' + error.message); }
    if (parsed?.decision === 'block') {
      if (parsed.suppressOriginalPrompt !== true) fail('UserPromptSubmit block without suppressOriginalPrompt');
      return { reason: typeof parsed.reason === 'string' ? parsed.reason : null };
    }
  }
  return null;
}

// The accepted UserPromptSubmit popup sends its enhanced body on stdout.
// With no popup, deliver the original prompt unchanged.
function promptFromAuto(stdout, original) {
  const line = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).reverse()
    .find((l) => l.startsWith('{') && l.includes('hookSpecificOutput'));
  if (!line) return original;
  let payload;
  try { payload = JSON.parse(line); } catch (e) { fail('malformed UserPromptSubmit JSON: ' + e.message); }
  const enhanced = payload?.hookSpecificOutput?.additionalContext;
  if (enhanced == null) return original;
  if (typeof enhanced !== 'string' || !enhanced.trim()) fail('invalid UserPromptSubmit additionalContext');
  return enhanced;
}

// Accepted Stop guidance has the shape {"decision":"block","reason":...}.
// No decision line means no guidance; malformed decisions are reported.
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

// Only new database rows are attributed to the current agent turn or continuation.
let lastAdvisoryId = null;
let lastPopupId = null;
function auditEvidence() {
  const none = { popup_prepared: false, popup_shown: false, pe_status: null,
    pe_sections: null, fired_flag: null };
  if (arm !== 'nexpath' || preprocessedNexpath || !existsSync(dbPath)) return none;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const available = (table) => Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const popup = available('pending_prompt_enhancements') ? db.prepare(
      'SELECT id, status, result_json FROM pending_prompt_enhancements ORDER BY id DESC LIMIT 1').get() : null;
    const advisory = available('pending_advisories') ? db.prepare(
      'SELECT id, flag_type FROM pending_advisories ORDER BY id DESC LIMIT 1').get() : null;
    const popupPrepared = Boolean(popup && popup.id !== lastPopupId);
    const advisoryFired = Boolean(advisory && advisory.id !== lastAdvisoryId);
    if (popup) lastPopupId = popup.id;
    if (advisory) lastAdvisoryId = advisory.id;
    let sections = null;
    if (popupPrepared) {
      try {
        const parsed = JSON.parse(popup.result_json);
        sections = Array.isArray(parsed?.currentBody?.sections)
          ? parsed.currentBody.sections.length : null;
      } catch { /* malformed evidence stays null */ }
    }
    return {
      popup_prepared: popupPrepared,
      popup_shown: popupPrepared && popup.status === 'shown',
      pe_status: popupPrepared ? popup.status : null,
      pe_sections: sections,
      fired_flag: advisoryFired ? advisory.flag_type : null,
    };
  } finally { db.close(); }
}
function eventFields(row, submitted) {
  const evidence = preprocessedNexpath ? {
    popup_prepared: null, popup_shown: row.pe_status === 'shown',
    pe_status: row.pe_status ?? null, pe_sections: row.pe_sections ?? null,
    fired_flag: row.fired_flag ?? null,
  } : auditEvidence();
  return { ...evidence,
    keeps_original_verbatim: submitted === null || submitted === row.raw_prompt
      ? null : submitted.includes(row.raw_prompt),
  };
}

let sessionId = null;
let blockedTurns = 0;
for (const row of rows) {
  const prefix = `turn-${String(row.turn).padStart(2, '0')}`;

  let submittedPrompt = preprocessedNexpath ? row.submit : row.raw_prompt;
  let autoBlock = null;
  if (arm === 'nexpath' && !preprocessedNexpath) {
    const autoResult = callNexpathHook(['auto', '-p', project, '--db', dbPath],
      autoPayload(row.raw_prompt, sessionId), prefix + '-auto');
    autoBlock = blockFromAuto(autoResult.stdout);
    if (!autoBlock) submittedPrompt = promptFromAuto(autoResult.stdout, row.raw_prompt);
  }
  if (autoBlock) {
    blockedTurns += 1;
    appendFileSync(join(out, 'agent-results.jsonl'), JSON.stringify({
      ...eventFields(row, null),
      turn: row.turn, prompt_sha256: sha256(row.raw_prompt),
      submitted_prompt_sha256: null, enhanced_used: false,
      auto_blocked: true, block_reason: autoBlock.reason,
      agent_invoked: false, session_id: sessionId,
      continuations: 0, patch_file: null, incremental_patch_file: null,
    }) + '\n');
    console.log('turn ' + row.turn + ': UserPromptSubmit blocked; no agent or Stop call');
    continue;
  }
  const { res, parsed, returnedSession } = runAgent(submittedPrompt, sessionId);
  const { cumulativeDiff, incrementalDiff } = writeStepArtifacts(prefix, res);

  let stopDecision = { kind: 'none' };
  if (arm === 'nexpath' && !preprocessedNexpath) {
    // Stop runs after the agent turn, including when the agent fails.
    const stopRes = callNexpathHook(['stop', '--db', dbPath], {
      cwd: project, hook_event_name: 'Stop', stop_hook_active: false,
      session_id: returnedSession ?? sessionId ?? null,
      ...(typeof parsed.result === 'string' ? { last_assistant_message: parsed.result } : {}),
    }, `${prefix}-stop`);
    stopDecision = parseStopDecision(stopRes.stdout);
  }

  const rowResult = {
    ...eventFields(row, submittedPrompt),
    turn: row.turn, prompt_sha256: sha256(row.raw_prompt),
    submitted_prompt_sha256: sha256(submittedPrompt),
    enhanced_used: preprocessedNexpath ? row.enhanced_used : submittedPrompt !== row.raw_prompt,
    auto_blocked: false, agent_invoked: true,
    ...agentMetrics(parsed),
    exit_code: res.status, signal: res.signal, process_error: res.error?.message || null,
    is_error: parsed.is_error ?? null, subtype: parsed.subtype ?? null,
    session_id: returnedSession, num_turns: parsed.num_turns ?? null,
    continuations: 0, continuation_limit_reached: false,
    patch_file: `${prefix}.patch`, patch_bytes: Buffer.byteLength(cumulativeDiff),
    incremental_patch_file: `${prefix}-incremental.patch`, incremental_patch_bytes: Buffer.byteLength(incrementalDiff),
  };
  console.log(`turn ${row.turn}: exit=${res.status} status=${parsed.subtype || 'unknown'} `
    + `patch=${rowResult.patch_bytes} bytes (own change: ${rowResult.incremental_patch_bytes} bytes)`);
  if (res.error || res.status !== 0 || parsed.is_error !== false
    || !Number.isSafeInteger(parsed.num_turns) || parsed.num_turns < 1
    || !returnedSession || (sessionId && returnedSession !== sessionId)) {
    appendFileSync(join(out, 'agent-results.jsonl'), JSON.stringify(rowResult) + '\n');
    fail(`agent turn ${row.turn} failed; inspect artifacts in ${out}`);
  }
  sessionId = returnedSession;

  // In standalone NexPath mode, accepted Stop guidance resumes the same Claude Code
  // session. Guidance is a separate continuation; the recorded frozen prompt
  // remains unchanged.
  let step = 0;
  let pendingDecision = stopDecision;
  let continuationLimitReached = false;
  while (arm === 'nexpath' && !preprocessedNexpath && pendingDecision.kind === 'accepted') {
    if (step >= maxContinuations) { continuationLimitReached = true; break; }
    step += 1;
    const contPrefix = `${prefix}-cont-${String(step).padStart(2, '0')}`;
    const guidance = pendingDecision.reason;

    // UserPromptSubmit for the injected turn, exactly as Claude Code fires it for a block
    // decision's continuation. In a real build NexPath's own echo guard (isInjectedPromptEcho,
    // src/decision-session/whydesc-delivery.ts) is what recognises this text came from its own
    // Stop hook and skips re-processing it as a fresh user prompt; offline tests mock that call.
    const autoContinuation = callNexpathHook(['auto', '-p', project, '--db', dbPath],
      autoPayload(guidance, sessionId), contPrefix + '-auto');
    const contAutoBlock = blockFromAuto(autoContinuation.stdout);
    if (contAutoBlock) {
      appendFileSync(join(out, 'continuations.jsonl'), JSON.stringify({
        ...eventFields(row, null),
        turn: row.turn, step, original_prompt_sha256: sha256(row.raw_prompt),
        injected_guidance_sha256: sha256(guidance),
        submitted_guidance_sha256: null, auto_blocked: true,
        block_reason: contAutoBlock.reason, agent_invoked: false,
        session_id: sessionId, hook_outcome: 'auto_blocked',
        patch_file: null, incremental_patch_file: null,
      }) + '\n');
      console.log('turn ' + row.turn + ' continuation ' + step + ': UserPromptSubmit blocked; no agent or Stop call');
      pendingDecision = { kind: 'none' };
      break;
    }
    const continuedPrompt = promptFromAuto(autoContinuation.stdout, guidance);
    const contCall = runAgent(continuedPrompt, sessionId);
    const { cumulativeDiff: contCumulativeDiff, incrementalDiff: contIncrementalDiff } = writeStepArtifacts(contPrefix, contCall.res);

    // Set stop_hook_active for a continuation after a blocked Stop response,
    // matching the NexPath hook loop guard (src/cli/commands/stop.ts).
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
      ...eventFields(row, continuedPrompt),
      turn: row.turn, step,
      original_prompt_sha256: sha256(row.raw_prompt),
      injected_guidance: guidance, injected_guidance_sha256: sha256(guidance),
      submitted_guidance_sha256: sha256(continuedPrompt),
      auto_blocked: false, agent_invoked: true,
      ...agentMetrics(contCall.parsed),
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
      || !Number.isSafeInteger(contCall.parsed.num_turns) || contCall.parsed.num_turns < 1
      || !contCall.returnedSession || contCall.returnedSession !== sessionId) {
      rowResult.continuations = step;
      appendFileSync(join(out, 'agent-results.jsonl'), JSON.stringify(rowResult) + '\n');
      fail(`agent turn ${row.turn} continuation ${step} failed; inspect artifacts in ${out}`);
    }
    sessionId = contCall.returnedSession;
    pendingDecision = contDecision;
  }
  if (pendingDecision.kind === 'malformed') {
    console.log(`turn ${row.turn}: WARNING: ignoring malformed Stop-hook decision (${pendingDecision.detail})`);
  }
  if (continuationLimitReached) {
    console.log(`turn ${row.turn}: CONTINUATION LIMIT REACHED (${maxContinuations}): further guidance was not delivered`);
  }
  rowResult.continuations = step;
  rowResult.continuation_limit_reached = continuationLimitReached;
  appendFileSync(join(out, 'agent-results.jsonl'), JSON.stringify(rowResult) + '\n');
}
console.log(`${arm.toUpperCase()} SESSION COMPLETE (NOT SCORED): ${out}`);
if (blockedTurns) console.log(`UserPromptSubmit blocked ${blockedTurns} frozen turn(s); no agent calls were made for those turns`);
const finalMetaPath = join(out, 'meta.json');
const finalMeta = JSON.parse(readFileSync(finalMetaPath, 'utf8'));
const readLines = (name) => {
  const file = join(out, name);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\\n').filter(Boolean).map(JSON.parse) : [];
};
const recordedSteps = [...readLines('agent-results.jsonl'), ...readLines('continuations.jsonl')];
finalMeta.finished_at = new Date().toISOString();
if (arm === 'nexpath' && !preprocessedNexpath) finalMeta.advisory_frequency = readLevel();
finalMeta.audit_totals = {
  popup_prepared: recordedSteps.filter((x) => x.popup_prepared === true).length,
  popup_shown: recordedSteps.filter((x) => x.popup_shown === true).length,
  cost_delta_usd: recordedSteps.reduce((sum, x) => sum + (x.cost_delta_usd ?? 0), 0),
  cost_records: recordedSteps.filter((x) => x.cost_delta_usd !== null && x.cost_delta_usd !== undefined).length,
};
writeFileSync(finalMetaPath, JSON.stringify(finalMeta, null, 2) + '\\n');

