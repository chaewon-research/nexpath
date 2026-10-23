import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `ps -o sid=` is used by a few regression tests below to check session/controlling-
// terminal isolation. Skip those tests outright on a machine where `ps` isn't on PATH,
// rather than failing for an unrelated reason.
let PS_AVAILABLE = true;
try { execSync('ps -o sid= -p ' + process.pid); } catch { PS_AVAILABLE = false; }

const driver = join(dirname(fileURLToPath(import.meta.url)), 'agent-driver.mjs');
const shell = (bin, args, opts={}) => {
  const r = spawnSync(bin,args,{encoding:'utf8',...opts});
  if (r.status!==0) throw Error(`${bin} ${args.join(' ')} failed: ${r.stderr}\n${r.stdout}`);
  return r.stdout.trim();
};
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'nexpath-agent-test-'));
  const project=join(root,'repo');mkdirSync(project);
  shell('git',['-C',project,'init','-q']);
  shell('git',['-C',project,'config','user.email','test@example.invalid']);
  shell('git',['-C',project,'config','user.name','Test']);
  writeFileSync(join(project,'notes.txt'),'original\n');
  shell('git',['-C',project,'add','notes.txt']);shell('git',['-C',project,'commit','-qm','fixture']);
  const run=join(root,'run');mkdirSync(run);
  writeFileSync(join(run,'meta.json'),JSON.stringify({schema:'custom_harness.run.v1',arm:'control',project,limit:2,task:'fixture'}));
  const turns=[1,2].map(i=>({turn:i,raw_prompt:`prompt ${i}`,submit:`prompt ${i}`,enhanced_used:false}));
  writeFileSync(join(run,'turns.jsonl'),turns.map(x=>JSON.stringify(x)).join('\n')+'\n');
  return {root,project,run};
}
function invoke(f,extra=[],env={}) {
  return spawnSync(process.execPath,[driver,`--turns=${join(f.run,'turns.jsonl')}`,`--project=${f.project}`,...extra], {encoding:'utf8',env:{...process.env,...env}});
}
function fixtureNexpath() {
  const root=mkdtempSync(join(tmpdir(),'nexpath-agent-test-'));
  const project=join(root,'repo');mkdirSync(project);
  shell('git',['-C',project,'init','-q']);
  shell('git',['-C',project,'config','user.email','test@example.invalid']);
  shell('git',['-C',project,'config','user.name','Test']);
  writeFileSync(join(project,'notes.txt'),'original\n');
  shell('git',['-C',project,'add','notes.txt']);shell('git',['-C',project,'commit','-qm','fixture']);
  const run=join(root,'run');mkdirSync(run);
  writeFileSync(join(run,'meta.json'),JSON.stringify({schema:'custom_harness.run.v1',arm:'nexpath',project,limit:2,task:'fixture'}));
  const turns=[1,2].map(i=>({turn:i,raw_prompt:`prompt ${i}`}));
  writeFileSync(join(run,'turns.jsonl'),turns.map(x=>JSON.stringify(x)).join('\n')+'\n');
  return {root,project,run};
}
// Logs one JSON line per call to MOCK_HISTORY; since every call is a blocking
// spawnSync, the resulting line order IS the call order the driver produced.
function writeMockNexpath(path) {
  writeFileSync(path, `#!/usr/bin/env node
const fs=require('fs');
let stdin='';
process.stdin.on('data',d=>stdin+=d);
process.stdin.on('end',()=>{
  const args=process.argv.slice(2);
  const hook=args[0];
  const dbIdx=args.indexOf('--db');
  const db=dbIdx>=0?args[dbIdx+1]:null;
  let payload={};
  try{payload=JSON.parse(stdin);}catch{}
  fs.appendFileSync(process.env.MOCK_HISTORY,JSON.stringify({kind:'nexpath',hook,db,payload})+'\\n');
  process.exit(0);
});
`);
  chmodSync(path,0o755);
}
// A `stop` mock whose stdout is driven by a plan file: plan[N] is what the Nth `stop` call
// (0-indexed, across the whole run) writes to stdout. A string entry is written raw (covers
// malformed/non-JSON output); an object entry is JSON-stringified (the real `{decision, reason}`
// shape, or a deliberately-wrong one); null/undefined writes nothing (the real "no guidance"
// exit). `auto` calls are recorded but never consume a plan slot. The counter lives in its own
// file because each call is a fresh process with no memory of the last one.
function writeMockNexpathStopPlan(path, planPath, counterPath) {
  writeFileSync(counterPath, '0');
  writeFileSync(path, `#!/usr/bin/env node
const fs=require('fs');
let stdin='';
process.stdin.on('data',d=>stdin+=d);
process.stdin.on('end',()=>{
  const args=process.argv.slice(2);
  const hook=args[0];
  const dbIdx=args.indexOf('--db');
  const db=dbIdx>=0?args[dbIdx+1]:null;
  let payload={};
  try{payload=JSON.parse(stdin);}catch{}
  fs.appendFileSync(process.env.MOCK_HISTORY,JSON.stringify({kind:'nexpath',hook,db,payload})+'\\n');
  if (hook==='stop') {
    process.stderr.write('[nexpath] stop hook ran\\n');   // noise that must never be read as a decision
    const plan=JSON.parse(fs.readFileSync(process.env.MOCK_STOP_PLAN,'utf8'));
    const n=Number(fs.readFileSync(process.env.MOCK_STOP_COUNTER,'utf8'));
    fs.writeFileSync(process.env.MOCK_STOP_COUNTER,String(n+1));
    const entry=plan[n];
    if (typeof entry==='string') process.stdout.write(entry);
    else if (entry) process.stdout.write(JSON.stringify(entry)+'\\n');
  }
  process.exit(0);
});
`);
  chmodSync(path, 0o755);
  writeFileSync(planPath, JSON.stringify([]));
}
function writeMockAgent(path, { failPrompt } = {}) {
  writeFileSync(path, `#!/usr/bin/env node
const fs=require('fs');
const a=process.argv.slice(2);
const prompt=a[a.indexOf('-p')+1];
const resume=a.includes('--resume')?a[a.indexOf('--resume')+1]:null;
fs.appendFileSync(process.env.MOCK_HISTORY,JSON.stringify({kind:'agent',prompt,resume})+'\\n');
if(prompt===${JSON.stringify(failPrompt ?? '')}){
  console.log(JSON.stringify({session_id:'mock-id',is_error:true,subtype:'error',num_turns:1,result:'boom'}));
  process.exit(9);
}
fs.writeFileSync('notes.txt', prompt === 'prompt 1' ? 'after-one\\n':'after-two\\n');
console.log(JSON.stringify({session_id:'mock-id',is_error:false,subtype:'success',num_turns:1,result:'done'}));
`);
  chmodSync(path,0o755);
}
test('dry run validates two turns without spawning agent or writing files',()=>{
  const f=fixture();const r=invoke(f);
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/DRY RUN PASS/);
  assert.equal(existsSync(join(f.run,'agent-driver')),false);
});
test('rejects inconsistent handoff before running agent',()=>{
  const f=fixture();
  let rows=readFileSync(join(f.run,'turns.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  rows[1].submit='tampered';writeFileSync(join(f.run,'turns.jsonl'),rows.map(JSON.stringify).join('\n'));
  const r=invoke(f,['--execute']);assert.notEqual(r.status,0);assert.match(r.stderr,/inconsistent/);
});
test('mock execution uses one persistent session, records patches and results',()=>{
  const f=fixture(); const mock=join(f.root,'mock-claude.cjs');const history=join(f.root,'mock-history.jsonl');
  writeFileSync(mock,`#!/usr/bin/env node\nconst fs=require('fs');\nconst a=process.argv.slice(2);\nconst prompt=a[a.indexOf('-p')+1];\nconst resume=a.includes('--resume')?a[a.indexOf('--resume')+1]:null;\nif((prompt==='prompt 1'&&resume)||(prompt==='prompt 2'&&resume!=='mock-id'))process.exit(9);\nfs.appendFileSync(process.env.MOCK_HISTORY,JSON.stringify({prompt,resume})+'\\n');\nfs.writeFileSync('notes.txt', prompt === 'prompt 1' ? 'after-one\\n':'after-two\\n');\nconsole.log(JSON.stringify({session_id:'mock-id',is_error:false,subtype:'success',num_turns:1,result:'done'}));\n`);
  chmodSync(mock,0o755);
  const r=invoke(f,['--execute',`--agent-bin=${mock}`,`--out=${join(f.root,'outputs')}`],{MOCK_HISTORY:history});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);assert.match(r.stdout,/CONTROL SESSION COMPLETE/);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls,[{prompt:'prompt 1',resume:null},{prompt:'prompt 2',resume:'mock-id'}]);
  assert.match(readFileSync(join(f.root,'outputs','turn-02.patch'),'utf8'),/after-two/);
  // Patch capture must not leave the project's index staged.
  shell('git',['-C',f.project,'diff','--cached','--quiet']);
  assert.match(shell('git',['-C',f.project,'status','--short']),/notes\.txt/);
  const results=readFileSync(join(f.root,'outputs','agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(results.map(r=>r.session_id),['mock-id','mock-id']);
});

test('nexpath arm calls UserPromptSubmit before the agent and Stop only after it completes',()=>{
  const f=fixtureNexpath();
  const mockNexpath=join(f.root,'mock-nexpath.cjs'); writeMockNexpath(mockNexpath);
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent);
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,`--nexpath-cli=${mockNexpath}`,`--out=${join(f.root,'outputs')}`],{MOCK_HISTORY:history});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  assert.match(r.stdout,/NEXPATH SESSION COMPLETE/);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.kind==='nexpath'?`${c.kind}:${c.hook}`:`${c.kind}:${c.prompt}`),
    ['nexpath:auto','agent:prompt 1','nexpath:stop','nexpath:auto','agent:prompt 2','nexpath:stop']);
  // auto gets the raw prompt verbatim and never rewrites it before the agent sees it
  assert.equal(calls[0].payload.prompt,'prompt 1');
  assert.equal(calls[3].payload.prompt,'prompt 2');
  // the per-run hook log also records the order, independent of the agent mock
  const hookLog=readFileSync(join(f.root,'outputs','nexpath-hooks.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(hookLog.map(h=>h.hook),['auto','stop','auto','stop']);
});

test('control arm never invokes NexPath, even when a (broken) --nexpath-cli is supplied',()=>{
  const f=fixture();
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent);
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,'--nexpath-cli=/does/not/exist',`--out=${join(f.root,'outputs')}`],{MOCK_HISTORY:history});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  assert.match(r.stdout,/CONTROL SESSION COMPLETE/);
  assert.equal(existsSync(join(f.root,'outputs','nexpath-hooks.jsonl')),false);
  assert.equal(existsSync(join(f.root,'outputs','session.db')),false);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.prompt),['prompt 1','prompt 2']);
});

test('nexpath arm continues one agent session across turns and threads it into the Stop payload',()=>{
  const f=fixtureNexpath();
  const mockNexpath=join(f.root,'mock-nexpath.cjs'); writeMockNexpath(mockNexpath);
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent);
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,`--nexpath-cli=${mockNexpath}`,`--out=${join(f.root,'outputs')}`],{MOCK_HISTORY:history});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  const agentCalls=calls.filter(c=>c.kind==='agent');
  assert.deepEqual(agentCalls.map(c=>c.resume),[null,'mock-id']);
  const stopCalls=calls.filter(c=>c.kind==='nexpath'&&c.hook==='stop');
  assert.deepEqual(stopCalls.map(c=>c.payload.session_id),['mock-id','mock-id']);
  assert.equal(stopCalls[0].payload.last_assistant_message,'done');
  const results=readFileSync(join(f.root,'outputs','agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(results.map(r=>r.session_id),['mock-id','mock-id']);
});

test('an agent failure still runs Stop for that turn, then fails the run',()=>{
  const f=fixtureNexpath();
  const mockNexpath=join(f.root,'mock-nexpath.cjs'); writeMockNexpath(mockNexpath);
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent,{failPrompt:'prompt 2'});
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,`--nexpath-cli=${mockNexpath}`,`--out=${join(f.root,'outputs')}`],{MOCK_HISTORY:history});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/agent turn 2 failed/);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.kind==='nexpath'?`${c.kind}:${c.hook}`:`${c.kind}:${c.prompt}`),
    ['nexpath:auto','agent:prompt 1','nexpath:stop','nexpath:auto','agent:prompt 2','nexpath:stop']);
  const results=readFileSync(join(f.root,'outputs','agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(results.length,2);
  assert.equal(results[0].is_error,false);
  assert.equal(results[1].is_error,true);
});

test('rejects a conditional turn when it does not match the frozen prompt file',()=>{
  const root=mkdtempSync(join(tmpdir(),'nexpath-agent-test-'));
  const project=join(root,'repo');mkdirSync(project);
  shell('git',['-C',project,'init','-q']);
  shell('git',['-C',project,'config','user.email','test@example.invalid']);
  shell('git',['-C',project,'config','user.name','Test']);
  writeFileSync(join(project,'notes.txt'),'original\n');
  shell('git',['-C',project,'add','notes.txt']);shell('git',['-C',project,'commit','-qm','fixture']);
  const run=join(root,'run');mkdirSync(run);
  const task='iterative__dvc_2.19.0_2.20.0';
  writeFileSync(join(run,'meta.json'),JSON.stringify({schema:'custom_harness.run.v1',arm:'control',project,limit:2,task}));
  const turns=[
    {turn:1,raw_prompt:'need to do the 2.20 release, heres whats in it\n\n## What\'s Changed\n* build: skip install fpm and ruby on Windows by @skshetry in https://github.com/iterative/dvc/pull/8169\n* import-url/update: add --no-download flag by @dtrifiro in https://github.com/iterative/dvc/pull/8024\n* fs: optimize dvc list --recursive by @rlamy in https://github.com/iterative/dvc/pull/8150\n\n## New Contributors\n* @rlamy made their first contribution in https://github.com/iterative/dvc/pull/8150\n\n**Full Changelog**: https://github.com/iterative/dvc/compare/2.19.0...2.20.0',submit:null,enhanced_used:false},
    // smuggled: this is turn 3's conditional pushback text, mislabeled as turn 2
    {turn:2,raw_prompt:'no not the tests, the real code',submit:null,enhanced_used:false},
  ];
  turns[0].submit=turns[0].raw_prompt; turns[1].submit=turns[1].raw_prompt;
  writeFileSync(join(run,'turns.jsonl'),turns.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const r=invoke({root,project,run},['--execute']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/does not match the frozen entry/);
});

// Stop-hook guidance delivery

test('accepted Stop-hook guidance is delivered to the same session as a separate continuation turn',()=>{
  const f=fixtureNexpath();
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath=join(f.root,'mock-nexpath.cjs');
  const planPath=join(f.root,'stop-plan.json'); const counterPath=join(f.root,'stop-counter.txt');
  writeMockNexpathStopPlan(mockNexpath,planPath,counterPath);
  writeFileSync(planPath,JSON.stringify([
    { decision:'block', reason:'please add a regression test' },  // turn 1 initial Stop
    null,                                                          // turn 1 continuation's Stop
    null,                                                          // turn 2 initial Stop
  ]));
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,`--nexpath-cli=${mockNexpath}`,`--out=${join(f.root,'outputs')}`],
    {MOCK_HISTORY:history,MOCK_STOP_PLAN:planPath,MOCK_STOP_COUNTER:counterPath});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  assert.match(r.stdout,/NEXPATH SESSION COMPLETE/);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.kind==='nexpath'?`${c.kind}:${c.hook}`:`${c.kind}:${c.prompt}`),[
    'nexpath:auto','agent:prompt 1','nexpath:stop',
    'nexpath:auto','agent:please add a regression test','nexpath:stop',   // the delivered continuation
    'nexpath:auto','agent:prompt 2','nexpath:stop',
  ]);
  // the continuation reuses the SAME session (--resume), never a fresh one
  const agentCalls=calls.filter(c=>c.kind==='agent');
  assert.deepEqual(agentCalls.map(c=>c.resume),[null,'mock-id','mock-id']);
  // the continuation's own Stop fires with stop_hook_active:true because Claude continues after
  // the previous block, exactly the condition the real loop guard checks for.
  const stopCalls=calls.filter(c=>c.kind==='nexpath'&&c.hook==='stop');
  assert.deepEqual(stopCalls.map(c=>c.payload.stop_hook_active),[false,true,false]);
  // recorded separately from the turn's own row
  const continuations=readFileSync(join(f.root,'outputs','continuations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(continuations.length,1);
  assert.equal(continuations[0].turn,1);
  assert.equal(continuations[0].injected_guidance,'please add a regression test');
  assert.equal(continuations[0].session_id,'mock-id');
  assert.equal(continuations[0].hook_outcome,'none');
  assert.equal(existsSync(join(f.root,'outputs','turn-01-cont-01.patch')),true);
  const results=readFileSync(join(f.root,'outputs','agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(results[0].continuations,1);
  assert.equal(results[0].continuation_limit_reached,false);
  assert.equal(results[1].continuations,0);
});

test('a Stop hook that never writes a block decision (no pending guidance) never triggers a continuation',()=>{
  const f=fixtureNexpath();
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath=join(f.root,'mock-nexpath.cjs');
  const planPath=join(f.root,'stop-plan.json'); const counterPath=join(f.root,'stop-counter.txt');
  writeMockNexpathStopPlan(mockNexpath,planPath,counterPath);  // every stop call writes nothing
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,`--nexpath-cli=${mockNexpath}`,`--out=${join(f.root,'outputs')}`],
    {MOCK_HISTORY:history,MOCK_STOP_PLAN:planPath,MOCK_STOP_COUNTER:counterPath});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  assert.equal(existsSync(join(f.root,'outputs','continuations.jsonl')),false);
  const results=readFileSync(join(f.root,'outputs','agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(results.map(r=>r.continuations),[0,0]);
});

test('a dismissed popup (silent stderr, no stdout decision) is handled identically to no guidance at all',()=>{
  const f=fixtureNexpath();
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath=join(f.root,'mock-nexpath.cjs');
  const planPath=join(f.root,'stop-plan.json'); const counterPath=join(f.root,'stop-counter.txt');
  writeMockNexpathStopPlan(mockNexpath,planPath,counterPath);
  // A dismiss writes human-readable noise to STDERR only (as the real hook does on other
  // outcomes) and nothing to stdout, ensuring stderr is never parsed as a decision.
  writeFileSync(planPath,JSON.stringify([]));
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,`--nexpath-cli=${mockNexpath}`,`--out=${join(f.root,'outputs')}`],
    {MOCK_HISTORY:history,MOCK_STOP_PLAN:planPath,MOCK_STOP_COUNTER:counterPath});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  assert.equal(existsSync(join(f.root,'outputs','continuations.jsonl')),false);
});

test('malformed Stop-hook stdout is reported and never treated as accepted guidance',()=>{
  const f=fixtureNexpath();
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath=join(f.root,'mock-nexpath.cjs');
  const planPath=join(f.root,'stop-plan.json'); const counterPath=join(f.root,'stop-counter.txt');
  writeMockNexpathStopPlan(mockNexpath,planPath,counterPath);
  writeFileSync(planPath,JSON.stringify([
    '{"decision":"block"\n',                           // turn 1: looks like JSON, fails to parse
    { decision:'allow', reason:'please add a test' },  // turn 2: valid JSON, wrong decision value
  ]));
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,`--nexpath-cli=${mockNexpath}`,`--out=${join(f.root,'outputs')}`],
    {MOCK_HISTORY:history,MOCK_STOP_PLAN:planPath,MOCK_STOP_COUNTER:counterPath});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  assert.match(r.stdout,/turn 1: WARNING: ignoring malformed Stop-hook decision/);
  assert.match(r.stdout,/turn 2: WARNING: ignoring malformed Stop-hook decision/);
  assert.equal(existsSync(join(f.root,'outputs','continuations.jsonl')),false);
});

test('a continuation limit stops delivering further guidance and is reported, without failing the run',()=>{
  const f=fixtureNexpath();
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath=join(f.root,'mock-nexpath.cjs');
  const planPath=join(f.root,'stop-plan.json'); const counterPath=join(f.root,'stop-counter.txt');
  writeMockNexpathStopPlan(mockNexpath,planPath,counterPath);
  writeFileSync(planPath,JSON.stringify([
    { decision:'block', reason:'first guidance' },   // turn 1 initial Stop
    { decision:'block', reason:'second guidance' },   // turn 1 continuation 1's Stop, still blocking
    null,                                              // turn 2 initial Stop
  ]));
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,`--nexpath-cli=${mockNexpath}`,
    `--out=${join(f.root,'outputs')}`,'--max-continuations=1'],
    {MOCK_HISTORY:history,MOCK_STOP_PLAN:planPath,MOCK_STOP_COUNTER:counterPath});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  assert.match(r.stdout,/CONTINUATION LIMIT REACHED \(1\)/);
  const continuations=readFileSync(join(f.root,'outputs','continuations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(continuations.length,1);
  assert.equal(continuations[0].injected_guidance,'first guidance');
  const results=readFileSync(join(f.root,'outputs','agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(results[0].continuations,1);
  assert.equal(results[0].continuation_limit_reached,true);
});

test('an agent failure during a continuation still runs that continuation\'s Stop, then fails the run',()=>{
  const f=fixtureNexpath();
  const mockAgent=join(f.root,'mock-agent.cjs'); writeMockAgent(mockAgent,{failPrompt:'please fix the bug'});
  const mockNexpath=join(f.root,'mock-nexpath.cjs');
  const planPath=join(f.root,'stop-plan.json'); const counterPath=join(f.root,'stop-counter.txt');
  writeMockNexpathStopPlan(mockNexpath,planPath,counterPath);
  writeFileSync(planPath,JSON.stringify([
    { decision:'block', reason:'please fix the bug' },  // turn 1 initial Stop, accepted
    null,                                                 // the failed continuation's own Stop
  ]));
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute',`--agent-bin=${mockAgent}`,`--nexpath-cli=${mockNexpath}`,`--out=${join(f.root,'outputs')}`],
    {MOCK_HISTORY:history,MOCK_STOP_PLAN:planPath,MOCK_STOP_COUNTER:counterPath});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/continuation 1 failed/);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.kind==='nexpath'?`${c.kind}:${c.hook}`:`${c.kind}:${c.prompt}`),[
    'nexpath:auto','agent:prompt 1','nexpath:stop',
    'nexpath:auto','agent:please fix the bug','nexpath:stop',   // Stop still ran after the failed agent call
  ]);
  const continuations=readFileSync(join(f.root,'outputs','continuations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(continuations.length,1);
  assert.equal(continuations[0].is_error,true);
  assert.equal(continuations[0].exit_code,9);
  const results=readFileSync(join(f.root,'outputs','agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(results.length,1);
  assert.equal(results[0].continuations,1);
});

test('processed runner handoff delivers accepted submit without re-invoking NexPath hooks',()=>{
  const f=fixtureNexpath();
  const rows=readFileSync(join(f.run,'turns.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const enhanced='prompt 1\n\nNexPath: check the release notes';
  for (const row of rows) {
    row.enhanced_prompt=row.turn===1?enhanced:null;
    row.submit=row.enhanced_prompt??row.raw_prompt;
    row.enhanced_used=Boolean(row.enhanced_prompt);
    row.keeps_original_verbatim=row.enhanced_prompt?true:null;
    row.fired_flag=row.turn===1?'stage_transition':null;
    row.pe_status=row.turn===1?'shown':null;
    row.pe_sections=row.turn===1?1:null;
  }
  writeFileSync(join(f.run,'turns.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  const mockAgent=join(f.root,'mock-agent.cjs');writeMockAgent(mockAgent);
  const history=join(f.root,'history.jsonl');
  const r=invoke(f,['--execute','--from-runner','--agent-bin='+mockAgent,'--out='+join(f.root,'outputs')],{MOCK_HISTORY:history});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.prompt),[enhanced,'prompt 2']);
  assert.equal(existsSync(join(f.root,'outputs','nexpath-hooks.jsonl')),false);
  assert.equal(existsSync(join(f.root,'outputs','session.db')),false);
  const results=readFileSync(join(f.root,'outputs','agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.notEqual(results[0].submitted_prompt_sha256,results[0].prompt_sha256);
  const agentMeta=JSON.parse(readFileSync(join(f.root,'outputs','meta.json'),'utf8'));
  assert.equal(agentMeta.hook_source,'run-session');
  assert.equal(agentMeta.arm_definition,'fixture');
});

test('processed runner handoff with partial hook fields is rejected',()=>{
  const f=fixtureNexpath();
  const rows=readFileSync(join(f.run,'turns.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  rows[0].fired_flag='stage_transition';
  writeFileSync(join(f.run,'turns.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  const r=invoke(f,['--from-runner']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/incomplete NexPath hook outcome fields/);
});

test('processed runner handoff refuses an inconsistent accepted prompt',()=>{
  const f=fixtureNexpath();
  const rows=readFileSync(join(f.run,'turns.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  for(const row of rows) {
    row.enhanced_prompt=null;
    row.submit=row.raw_prompt;
    row.enhanced_used=false;
    row.keeps_original_verbatim=null;
    row.fired_flag=null;
    row.pe_status=null;
    row.pe_sections=null;
  }
  rows[0].enhanced_prompt='prompt 1 with guidance';
  rows[0].enhanced_used=true;
  writeFileSync(join(f.run,'turns.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  const r=invoke(f,['--from-runner']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/inconsistent accepted NexPath handoff/);
});

// Regression tests for terminal isolation, hook failures, credential
// handling, and incremental patch recording.

// Reports the probing process's own session id (via `ps -o sid=`), so a test can tell
// whether the nexpath subprocess shares our controlling terminal (same session) or was
// assigned its own private PTY session (sid === its pid). This verifies that
// NexPath's `/dev/tty` popup cannot take over the test runner's terminal.
function writeMockNexpathSidProbe(path) {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  let sid = 'ERR';
  try { sid = execSync('ps -o sid= -p ' + process.pid).toString().trim(); } catch (e) { sid = 'ERR:' + e.message; }
  fs.appendFileSync(process.env.MOCK_HISTORY, JSON.stringify({ kind: 'nexpath', hook: process.argv[2], pid: process.pid, sid }) + '\\n');
  process.exit(0);
});
`);
  chmodSync(path, 0o755);
}

// Exits nonzero (a crash), hangs long enough to be killed by --nexpath-timeout-seconds
// (spawnSync's own timeout kill, which also sets `res.error`), or kills ITSELF with a
// signal (what an OOM-killer or a SIGSEGV/SIGABRT crash looks like: only `res.signal` is
// set, never `res.error`) -- the subprocess-failure shapes `callNexpathHook` must not
// silently read as "no guidance".
function writeMockNexpathFailing(path, { exitCode = 0, sleepMs = 0, selfSignal = null } = {}) {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.MOCK_HISTORY, JSON.stringify({ kind: 'nexpath', hook: process.argv[2] }) + '\\n');
  ${selfSignal ? `process.kill(process.pid, ${JSON.stringify(selfSignal)});` : `setTimeout(() => { process.exit(${exitCode}); }, ${sleepMs});`}
});
`);
  chmodSync(path, 0o755);
}

// Reports the env HOME it was actually invoked with, so a test can confirm the nexpath
// subprocess never sees the real operator home (where a stored keychain/file credential
// would normally be looked up from).
function writeMockNexpathHomeProbe(path) {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.MOCK_HISTORY, JSON.stringify({ kind: 'nexpath', hook: process.argv[2], home: process.env.HOME || null }) + '\\n');
  process.exit(0);
});
`);
  chmodSync(path, 0o755);
}

// Turn 1 creates a brand-new, never-staged file (the shape a bare `git diff` drops
// entirely); turn 2 instead edits the existing tracked file, exactly like writeMockAgent.
function writeMockAgentCreatesFile(path) {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const prompt = a[a.indexOf('-p') + 1];
if (prompt === 'prompt 1') {
  fs.writeFileSync('brand-new.txt', 'created by turn 1\\n');
} else {
  fs.writeFileSync('notes.txt', 'after-two\\n');
}
console.log(JSON.stringify({ session_id: 'mock-id', is_error: false, subtype: 'success', num_turns: 1, result: 'done' }));
`);
  chmodSync(path, 0o755);
}

test('nexpath hooks get private terminal sessions, separate from the operator terminal', { skip: !PS_AVAILABLE }, () => {
  const f = fixtureNexpath();
  const mockAgent = join(f.root, 'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath = join(f.root, 'mock-nexpath-sid.cjs'); writeMockNexpathSidProbe(mockNexpath);
  const history = join(f.root, 'history.jsonl');
  const r = invoke(f, ['--execute', `--agent-bin=${mockAgent}`, `--nexpath-cli=${mockNexpath}`, `--out=${join(f.root, 'outputs')}`], { MOCK_HISTORY: history });
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  const ownSid = execSync('ps -o sid= -p ' + process.pid).toString().trim();
  const calls = readFileSync(history, 'utf8').trim().split('\n').map(JSON.parse).filter((c) => c.kind === 'nexpath');
  assert.equal(calls.length, 4); // auto,stop per turn x2 turns, no continuation (mock emits no decision)
  for (const c of calls) {
    assert.notEqual(c.sid, ownSid, `${c.hook} call shares this test's session -- its /dev/tty popup probe could attach to our terminal`);
    assert.equal(c.sid, String(c.pid), `${c.hook} did not receive its own PTY session`);
  }
});

test('a nexpath hook that exits nonzero fails the run loudly instead of being read as "no guidance"', () => {
  const f = fixtureNexpath();
  const mockAgent = join(f.root, 'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath = join(f.root, 'mock-nexpath-crash.cjs'); writeMockNexpathFailing(mockNexpath, { exitCode: 7 });
  const history = join(f.root, 'history.jsonl');
  const r = invoke(f, ['--execute', `--agent-bin=${mockAgent}`, `--nexpath-cli=${mockNexpath}`, `--out=${join(f.root, 'outputs')}`], { MOCK_HISTORY: history });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /nexpath auto .*exited with status 7/);
  // The crash must not be mistaken for a clean "no guidance" Stop outcome anywhere downstream.
  assert.equal(existsSync(join(f.root, 'outputs', 'continuations.jsonl')), false);
});

test('a nexpath hook killed by the --nexpath-timeout-seconds timeout fails the run loudly, never silently "no guidance"', () => {
  const f = fixtureNexpath();
  const mockAgent = join(f.root, 'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath = join(f.root, 'mock-nexpath-hang.cjs'); writeMockNexpathFailing(mockNexpath, { sleepMs: 5000 });
  const history = join(f.root, 'history.jsonl');
  const r = invoke(f, ['--execute', `--agent-bin=${mockAgent}`, `--nexpath-cli=${mockNexpath}`, `--out=${join(f.root, 'outputs')}`, '--nexpath-timeout-seconds=1'], { MOCK_HISTORY: history });
  assert.notEqual(r.status, 0);
  // The PTY wrapper reports child timeout; the outer spawn has a cleanup buffer.
  assert.match(r.stderr, /nexpath auto .*timed out after|nexpath auto .*failed to spawn.*ETIMEDOUT/);
  assert.equal(existsSync(join(f.root, 'outputs', 'continuations.jsonl')), false);
});

test('a nexpath hook killed by a signal OTHER than our own timeout (e.g. OOM-killer, a crash) fails the run loudly too', { skip: !PS_AVAILABLE }, () => {
  const f = fixtureNexpath();
  const mockAgent = join(f.root, 'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath = join(f.root, 'mock-nexpath-selfkill.cjs'); writeMockNexpathFailing(mockNexpath, { selfSignal: 'SIGTERM' });
  const history = join(f.root, 'history.jsonl');
  const r = invoke(f, ['--execute', `--agent-bin=${mockAgent}`, `--nexpath-cli=${mockNexpath}`, `--out=${join(f.root, 'outputs')}`], { MOCK_HISTORY: history });
  assert.notEqual(r.status, 0);
  // This path carries no `res.error` at all (unlike the timeout above) -- only `res.signal` --
  // so it specifically exercises the new explicit signal check, not the pre-existing one.
  assert.match(r.stderr, /nexpath auto .*was killed by signal SIGTERM/);
  assert.equal(existsSync(join(f.root, 'outputs', 'continuations.jsonl')), false);
});

test('the nexpath subprocess HOME is sandboxed to a fresh run-local directory, never the real home or an inherited override', () => {
  const f = fixtureNexpath();
  const mockAgent = join(f.root, 'mock-agent.cjs'); writeMockAgent(mockAgent);
  const mockNexpath = join(f.root, 'mock-nexpath-home.cjs'); writeMockNexpathHomeProbe(mockNexpath);
  const history = join(f.root, 'history.jsonl');
  const outDir = join(f.root, 'outputs');
  const r = invoke(f, ['--execute', `--agent-bin=${mockAgent}`, `--nexpath-cli=${mockNexpath}`, `--out=${outDir}`],
    { MOCK_HISTORY: history, HOME: '/should/not/be/used' });
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  const calls = readFileSync(history, 'utf8').trim().split('\n').map(JSON.parse).filter((c) => c.kind === 'nexpath');
  assert.equal(calls.length, 4);
  const expectedHome = resolve(join(outDir, 'nexpath-home'));
  for (const c of calls) {
    assert.notEqual(c.home, process.env.HOME, `${c.hook} call saw the real test-runner HOME`);
    assert.notEqual(c.home, '/should/not/be/used', `${c.hook} call saw an inherited HOME override instead of the sandbox`);
    assert.equal(resolve(c.home), expectedHome);
    assert.equal(existsSync(join(c.home, '.nexpath', 'config.json')), false);
  }
  const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
  assert.equal(meta.credential_isolation.home_sandboxed, true);
  assert.equal(meta.credential_isolation.keychain_sandboxed, false); // documented, unfixable-from-here limitation
  assert.equal(resolve(meta.credential_isolation.nexpath_home), expectedHome);
});

test('a newly created (untracked) file is captured in the patch, and the incremental patch holds only that step\'s own change', () => {
  const f = fixture(); // control arm -- NexPath involvement is irrelevant to patch accuracy
  const mockAgent = join(f.root, 'mock-agent-newfile.cjs'); writeMockAgentCreatesFile(mockAgent);
  const outDir = join(f.root, 'outputs');
  const r = invoke(f, ['--execute', `--agent-bin=${mockAgent}`, `--out=${outDir}`]);
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);

  const turn1Patch = readFileSync(join(outDir, 'turn-01.patch'), 'utf8');
  const turn1Incr = readFileSync(join(outDir, 'turn-01-incremental.patch'), 'utf8');
  // A bare `git diff` (the old implementation) never shows an untracked file's content at
  // all -- only `git status --short`'s `??` line would have named it.
  assert.match(turn1Patch, /brand-new\.txt/);
  assert.match(turn1Patch, /created by turn 1/);
  assert.match(turn1Incr, /created by turn 1/);

  const turn2Patch = readFileSync(join(outDir, 'turn-02.patch'), 'utf8');
  const turn2Incr = readFileSync(join(outDir, 'turn-02-incremental.patch'), 'utf8');
  // The cumulative patch keeps including every earlier step, as before...
  assert.match(turn2Patch, /created by turn 1/);
  assert.match(turn2Patch, /after-two/);
  // ...but the incremental one -- new in this fix -- holds ONLY turn 2's own edit, so a
  // grader reading it never mistakes turn 1's change for something turn 2 did.
  assert.doesNotMatch(turn2Incr, /created by turn 1/);
  assert.match(turn2Incr, /after-two/);

  const results = readFileSync(join(outDir, 'agent-results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(results[0].patch_file, 'turn-01.patch');
  assert.equal(results[0].incremental_patch_file, 'turn-01-incremental.patch');
  assert.ok(results[0].patch_bytes > 0 && results[0].incremental_patch_bytes > 0);
  assert.equal(results[1].patch_file, 'turn-02.patch');
  assert.equal(results[1].incremental_patch_file, 'turn-02-incremental.patch');
  // Turn 2's cumulative patch is strictly bigger than its own incremental change, since the
  // former also carries turn 1's addition and the latter does not.
  assert.ok(results[1].patch_bytes > results[1].incremental_patch_bytes);
});

test('zero-turn agent result is not considered success',()=>{
  const f=fixture();
  const mock=join(f.root,'zero-agent.cjs');
  writeFileSync(mock,"#!/usr/bin/env node\nconsole.log(JSON.stringify({session_id:'mock-id',is_error:false,subtype:'success',num_turns:0,result:''}));\n");
  chmodSync(mock,0o755);
  const out=join(f.root,'outputs');
  const r=invoke(f,['--execute','--agent-bin='+mock,'--out='+out]);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/agent turn 1 failed/);
  assert.doesNotMatch(r.stdout,/SESSION COMPLETE/);
  const row=JSON.parse(readFileSync(join(out,'agent-results.jsonl'),'utf8').trim());
  assert.equal(row.num_turns,0);
  assert.equal(row.patch_bytes,0);
});

test('Claude starts with all setting sources disabled in both arms',()=>{
  for (const arm of ['control','nexpath']) {
    const f=arm==='control'?fixture():fixtureNexpath();
    const agent=join(f.root,'argv-agent.cjs');
    writeFileSync(agent,"#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(process.env.MOCK_AGENT_ARGS,JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({session_id:'mock-id',is_error:false,subtype:'success',num_turns:1,result:'done'}));\n");
    chmodSync(agent,0o755);
    const cli=join(f.root,'mock-nexpath.cjs');writeMockNexpath(cli);
    const history=join(f.root,'history.jsonl'),argvLog=join(f.root,'argv.jsonl');
    const args=['--execute','--agent-bin='+agent,'--out='+join(f.root,'outputs')];
    if(arm==='nexpath')args.push('--nexpath-cli='+cli);
    const r=invoke(f,args,{MOCK_HISTORY:history,MOCK_AGENT_ARGS:argvLog});
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
    const calls=readFileSync(argvLog,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length,2);
    for (const argv of calls) {
      const pos=argv.indexOf('--setting-sources');
      assert.ok(pos>=0);
      assert.equal(argv[pos+1],'');
    }
  }
});

test('proxy argument validation and unreachable proxy stop execution',()=>{
  const f=fixtureNexpath();
  const withoutUrl=invoke(f,['--require-proxy-mode=replay']);
  assert.notEqual(withoutUrl.status,0);
  assert.match(withoutUrl.stderr,/requires --proxy-url/);
  const cli=join(f.root,'mock-nexpath.cjs');writeMockNexpath(cli);
  const agent=join(f.root,'mock-agent.cjs');writeMockAgent(agent);
  const history=join(f.root,'history.jsonl');
  const unreachable=invoke(f,['--execute','--proxy-url=http://127.0.0.1:1/v1','--require-proxy-mode=replay',
    '--agent-bin='+agent,'--nexpath-cli='+cli],{MOCK_HISTORY:history});
  assert.notEqual(unreachable.status,0);
  assert.match(unreachable.stderr,/no valid harness proxy answering/);
  assert.equal(existsSync(history),false);
});

test('proxy replay mode is verified and carried to NexPath hooks',async()=>{
  const f=fixtureNexpath();
  const serverScript="const http=require('http');const s=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({mode:'replay',saved:1}));});s.listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)+'\\n'));";
  const server=spawn(process.execPath,['-e',serverScript],{stdio:['ignore','pipe','pipe']});
  const port=await new Promise((resolve,reject)=>{
    let data='';
    server.once('error',reject);
    server.once('exit',()=>reject(new Error('proxy server failed to start')));
    server.stdout.on('data',part=>{data+=part.toString();if(data.includes('\n'))resolve(Number(data.trim()));});
  });
  try {
    const cli=join(f.root,'nexpath-env.cjs');
    writeFileSync(cli,"#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(process.env.MOCK_HISTORY,JSON.stringify({base:process.env.OPENAI_BASE_URL||null,hook:process.argv[2]})+'\\n');\n");
    chmodSync(cli,0o755);
    const agent=join(f.root,'mock-agent.cjs');writeMockAgent(agent);
    const history=join(f.root,'history.jsonl'),url='http://127.0.0.1:'+port+'/v1';
    const out=join(f.root,'outputs');
    const r=invoke(f,['--execute','--proxy-url='+url,'--require-proxy-mode=replay',
      '--agent-bin='+agent,'--nexpath-cli='+cli,'--out='+out],{MOCK_HISTORY:history});
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
    const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.filter(x=>x.hook).map(x=>x.base),[url,url,url,url]);
    const meta=JSON.parse(readFileSync(join(out,'meta.json'),'utf8'));
    assert.equal(meta.proxy,url);
    assert.equal(meta.proxy_mode,'replay');
    const bad=fixtureNexpath();
    const badHistory=join(bad.root,'history.jsonl');
    const mismatch=invoke(bad,['--execute','--proxy-url='+url,'--require-proxy-mode=record',
      '--agent-bin='+agent,'--nexpath-cli='+cli],{MOCK_HISTORY:badHistory});
    assert.notEqual(mismatch.status,0);
    assert.match(mismatch.stderr,/proxy mode is "replay"/);
    assert.equal(existsSync(badHistory),false);
  } finally {
    server.kill();
  }
});

test('standalone UserPromptSubmit popup uses private PTY and forwards accepted context',()=>{
  const f=fixtureNexpath();
  const agent=join(f.root,'mock-agent.cjs'); writeMockAgent(agent);
  const cli=join(f.root,'mock-popup.cjs');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  const payload=JSON.parse(input);
  fs.appendFileSync(process.env.MOCK_HISTORY,JSON.stringify({kind:'nexpath',hook:process.argv[2]})+'\\n');
  if(process.argv[2]==='auto' && payload.prompt==='prompt 1'){
    const tty=fs.openSync('/dev/tty','r+');
    fs.writeSync(tty,'Enter sends this prompt\\n');
    fs.readSync(tty,Buffer.alloc(64),0,64,null);
    fs.closeSync(tty);
    console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'prompt 1\\nNexPath guidance: check release notes'}}));
  }
});
`);
  chmodSync(cli,0o755);
  const history=join(f.root,'history.jsonl'), out=join(f.root,'outputs');
  const r=invoke(f,['--execute','--agent-bin='+agent,'--nexpath-cli='+cli,'--out='+out],{MOCK_HISTORY:history});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(c=>c.kind==='agent').map(c=>c.prompt),['prompt 1\nNexPath guidance: check release notes','prompt 2']);
  const results=readFileSync(join(out,'agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(results[0].enhanced_used,true);
  assert.notEqual(results[0].submitted_prompt_sha256,results[0].prompt_sha256);
  assert.equal(results[1].enhanced_used,false);
  assert.match(readFileSync(join(out,'turn-01-auto-tty.log'),'utf8'),/Enter sends this prompt/);
});

test('NexPath hook-outcome handoffs cannot be mistaken for measured standalone runs',()=>{
  const f=fixtureNexpath();
  const rows=readFileSync(join(f.run,'turns.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  for (const row of rows) {
    row.enhanced_prompt=null;
    row.submit=row.raw_prompt;
    row.enhanced_used=false;
    row.fired_flag=null;
    row.pe_status=null;
    row.pe_sections=null;
    row.keeps_original_verbatim=null;
  }
  writeFileSync(join(f.run,'turns.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  const result=invoke(f);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/requires --from-runner/);
});

test('--from-runner rejects standalone NexPath rows without hook outcome fields',()=>{
  const f=fixtureNexpath();
  const result=invoke(f,['--from-runner']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/requires processed NexPath rows/);
});

test('standalone blocked UserPromptSubmit never forwards the original prompt',()=>{
  const f=fixtureNexpath();
  const agent=join(f.root,'mock-agent.cjs');writeMockAgent(agent);
  const cli=join(f.root,'mock-blocking-auto.cjs');
  writeFileSync(cli,"#!/usr/bin/env node\nconst fs=require('fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const payload=JSON.parse(input);const hook=process.argv[2];fs.appendFileSync(process.env.MOCK_HISTORY,JSON.stringify({kind:'nexpath',hook,prompt:payload.prompt||null})+'\\n');if(hook==='auto'&&payload.prompt==='prompt 1')console.log(JSON.stringify({decision:'block',reason:'popup dismissed',suppressOriginalPrompt:true}));});\n");
  chmodSync(cli,0o755);
  const history=join(f.root,'history.jsonl'),out=join(f.root,'outputs');
  const result=invoke(f,['--execute','--agent-bin='+agent,'--nexpath-cli='+cli,'--out='+out],{MOCK_HISTORY:history});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(c=>c.kind==='agent').map(c=>c.prompt),['prompt 2']);
  assert.equal(calls.filter(c=>c.kind==='nexpath'&&c.hook==='stop').length,1);
  const rows=readFileSync(join(out,'agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].auto_blocked,true);
  assert.equal(rows[0].agent_invoked,false);
  assert.equal(rows[0].submitted_prompt_sha256,null);
  assert.equal(rows[0].block_reason,'popup dismissed');
  assert.equal(rows[1].auto_blocked,false);
  assert.equal(JSON.parse(readFileSync(join(out,'meta.json'),'utf8')).arm_definition,'standalone');
});

test('blocked continuation does not run the agent or its Stop hook',()=>{
  const f=fixtureNexpath();
  const agent=join(f.root,'mock-agent.cjs');writeMockAgent(agent);
  const cli=join(f.root,'mock-cont-block.cjs');
  writeFileSync(cli,"#!/usr/bin/env node\nconst fs=require('fs');let data='';process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>{const hook=process.argv[2],payload=JSON.parse(data);const history=process.env.MOCK_HISTORY;const previous=fs.existsSync(history)?fs.readFileSync(history,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];fs.appendFileSync(history,JSON.stringify({kind:'nexpath',hook,prompt:payload.prompt||null})+'\\n');if(hook==='stop'&&!previous.some(c=>c.hook==='stop'))console.log(JSON.stringify({decision:'block',reason:'please fix issue'}));if(hook==='auto'&&payload.prompt==='please fix issue')console.log(JSON.stringify({decision:'block',reason:'not sent',suppressOriginalPrompt:true}));});\n");
  chmodSync(cli,0o755);
  const history=join(f.root,'history.jsonl'),out=join(f.root,'outputs');
  const result=invoke(f,['--execute','--agent-bin='+agent,'--nexpath-cli='+cli,'--out='+out],{MOCK_HISTORY:history});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(c=>c.kind==='agent').map(c=>c.prompt),['prompt 1','prompt 2']);
  assert.equal(calls.filter(c=>c.kind==='nexpath'&&c.hook==='stop').length,2);
  const rows=readFileSync(join(out,'continuations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,1);
  assert.equal(rows[0].auto_blocked,true);
  assert.equal(rows[0].agent_invoked,false);
  assert.equal(rows[0].submitted_guidance_sha256,null);
});


function fullFrozenFixture() {
  const f=fixture();
  const task='iterative__dvc_2.19.0_2.20.0';
  const frozen=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'..','prompts',task+'.json'),'utf8'));
  const rows=frozen.prompts.map(p=>({turn:p.n,raw_prompt:p.text,submit:p.text,enhanced_used:false}));
  writeFileSync(join(f.run,'meta.json'),JSON.stringify({schema:'custom_harness.run.v1',arm:'control',project:f.project,task}));
  writeFileSync(join(f.run,'turns.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
  return { ...f, frozen, rows };
}

test('all 20 frozen prompts including conditional turns reach one session in exact order',()=>{
  const f=fullFrozenFixture();
  const agent=join(f.root,'mock-agent.cjs');writeMockAgent(agent);
  const history=join(f.root,'history.jsonl'),out=join(f.root,'outputs');
  const r=invoke(f,['--execute','--agent-bin='+agent,'--out='+out],{MOCK_HISTORY:history});
  assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  assert.match(r.stdout,/SESSION COMPLETE/);
  const calls=readFileSync(history,'utf8').trim().split('\n').map(JSON.parse).filter(c=>c.kind==='agent');
  assert.equal(calls.length,20);
  assert.deepEqual(calls.map(c=>c.prompt),f.rows.map(p=>p.raw_prompt));
  assert.deepEqual(calls.map(c=>c.resume),[null,...Array(19).fill('mock-id')]);
  const results=readFileSync(join(out,'agent-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(results.map(x=>x.turn),Array.from({length:20},(_,i)=>i+1));
  const metadata=JSON.parse(readFileSync(join(out,'meta.json'),'utf8'));
  assert.equal(metadata.mode,'complete_frozen_session');
  assert.equal(metadata.frozen_prompts,20);
});

test('full benchmark input cannot omit later frozen prompts',()=>{
  const f=fullFrozenFixture();
  writeFileSync(join(f.run,'turns.jsonl'),f.rows.slice(0,2).map(JSON.stringify).join('\n')+'\n');
  const r=invoke(f);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/full frozen session requires all 20 prompts/);
});

test('full benchmark input cannot reorder frozen prompts',()=>{
  const f=fullFrozenFixture();
  const reordered=[...f.rows];
  [reordered[3],reordered[4]]=[reordered[4],reordered[3]];
  writeFileSync(join(f.run,'turns.jsonl'),reordered.map(JSON.stringify).join('\n')+'\n');
  const r=invoke(f);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/inconsistent frozen handoff/);
});
