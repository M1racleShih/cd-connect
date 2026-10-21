// Regression contracts from independent review; all fixtures are isolated.
// Only disposable local fixtures; no real Codex model, DSH account, or live tasks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync,writeFileSync,existsSync,readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStdio } from '../src/coordinator/codex.js';
import { Journal } from '../src/coordinator/store.js';
import { Coordinator } from '../src/coordinator/coordinator.js';
import { listenHealth } from '../src/server.js';
import { fixture,snapshot } from './support/coordinator-fixture.js';
const repo=fileURLToPath(new URL('../',import.meta.url));
const peer=fileURLToPath(new URL('./support/event-review-peer.js',import.meta.url));
const quote=s=>`'${s.replaceAll("'", "'\"'\"'")}'`;
async function cli(args,env={}) {
  const child=spawn(process.execPath,[join(repo,'scripts/event-coordinator.js'),...args],{cwd:repo,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  const [code]=await once(child,'close');return {code,output};
}
async function setupCli(t,f,task=snapshot()) {
  const bin=join(f.dir,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'codex'),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peer)}\n`,{mode:0o700});
  const server=await listenHealth({port:0,token:'e'.repeat(64),readHealth:()=>({...f.config.binding,profile:'desktop'}),tasks:{call:async name=>{if(name==='task_get')return task;throw new Error('fixture_unexpected_call');}}});
  t.after(()=>server.close());
  writeFileSync(join(f.dir,'connection.json'),JSON.stringify({url:server.url,token:'e'.repeat(64)}),{mode:0o600});
  return {PATH:`${bin}:${process.env.PATH}`};
}
test('control clean CLI binding completes with this isolated protocol peer',async t=>{
  const f=fixture(t);const env=await setupCli(t,f);f.journal.close();
  const result=await cli(['run',f.dir],env);
  assert.equal(result.code,0,result.output);assert.equal(Journal.read(f.dir).notifications[0].status,'completed');
});
test('R1 preserve a multibyte UTF-8 character across pipe chunks',async()=>{
  const c=new CodexStdio({command:process.execPath,args:[peer]});
  try { const result=await c.request('utf8');assert.equal(result.text,'建议通过'); }
  finally { await c.close(); }
});
test('R2 an explicit writer rejection must not permanently disable a later authorized resume',async t=>{
  const f=fixture(t);const env=await setupCli(t,f);f.journal.close();
  const refused=await cli(['run',f.dir],{...env,REVIEW_REJECT:'1'});
  assert.equal(refused.code,1);assert.match(refused.output,/codex_rpc_minus_32600/);
  const reconciled=await cli(['reconcile',f.dir],env);assert.equal(reconciled.code,0);
  const retry=await cli(['run',f.dir],env);
  t.diagnostic(JSON.stringify({lifecycle:Journal.read(f.dir).lifecycle,retry}));
  assert.equal(retry.code,0,'released writer and read-only reconciliation should allow retry without recreating the ledger');
});
test('R3 stopping must not hide failure to observe an active review',async t=>{
  const f=fixture(t);const start=f.codex.start;
  f.codex.start=async(...args)=>{const r=await start(...args);f.codex.turns[0].status='inProgress';f.coordinator.stop();return r;};
  f.codex.history=async()=>{throw new Error('codex_receipt_timeout');};
  let failure;try { await f.coordinator.run(); } catch(e) { failure=e; }
  t.diagnostic(JSON.stringify({mode:f.journal.data.mode,error:f.journal.data.error,status:f.journal.data.notifications[0].status,thrown:failure?.message??null}));
  assert.ok(failure,'an active review with an observation failure must not be reported as a normal stop');
});
test('R4 a historical failed review must not fail a successful later binding',async t=>{
  const f=fixture(t);f.journal.data.notifications.push({key:'old-key',marker:'old-marker',source_cursor:0,status:'failed',turn_id:'old-turn',final_status:'failed'});f.journal.save();
  const env=await setupCli(t,f);f.journal.close();
  const result=await cli(['run',f.dir],env);const state=Journal.read(f.dir);
  t.diagnostic(JSON.stringify({result,mode:state.mode,statuses:state.notifications.map(n=>n.status)}));
  assert.equal(state.notifications.at(-1).status,'completed');
  assert.equal(result.code,0);
});
test('R5 rearming an identical pending binding must not discard an expired event cursor',async t=>{
  const f=fixture(t);f.journal.data.cursor=1;f.journal.data.baseline_cursor=1;
  await f.coordinator.observe({...snapshot(),event_cursor:1});
  f.bridge.task={...snapshot(),event_cursor:400};const read=f.bridge.read.bind(f.bridge);
  f.bridge.read=async(name,...args)=>{if(name==='task_wait')throw new Error('cursor_expired_inspect_DSH');return read(name,...args);};
  await assert.rejects(f.coordinator.run(),/cursor_expired/);assert.equal(f.codex.starts.length,0);
  const env=await setupCli(t,f,f.bridge.task);const bindingFile=join(f.dir,'binding.json');writeFileSync(bindingFile,JSON.stringify(f.config.binding),{mode:0o600});f.journal.close();
  const rearm=await cli(['rearm',f.dir,bindingFile],env);assert.equal(rearm.code,0);
  const j=new Journal(f.dir);t.after(()=>j.close());await assert.rejects(new Coordinator(j,f.bridge,f.codex).run(),/cursor_expired/);
  assert.equal(j.data.cursor,1);assert.equal(j.data.baseline_cursor,1);
  t.diagnostic(JSON.stringify({cursor:j.data.cursor,attempts:j.data.stats.attempts,status:j.data.notifications[0].status}));
  assert.equal(f.codex.starts.length,0,'same binding must preserve the cursor gap instead of sending');
});

test('R1 bytewise Chinese, emoji, JSONL boundaries and escaped newlines remain intact',async()=>{
  const c=new CodexStdio({command:process.execPath,args:[peer]});
  try{
    const notification=once(c,'notification');
    assert.deepEqual(await c.request('utf8-lines'),{text:'建议通过🙂\n下一行'});
    assert.equal((await notification)[0].params.text,'中文🙂');
  }finally{await c.close();}
});
for(const [method,code] of [['truncated','codex_invalid_response'],['oversized','codex_response_too_large']]){
  test(`R1 ${method} stream fails closed`,async()=>{
    const c=new CodexStdio({command:process.execPath,args:[peer]});
    try{await assert.rejects(c.request(method),e=>e.message===code);}finally{await c.close();}
  });
}

test('R2 unknown attachment requires explicit exclusive read-only lifecycle reconciliation',async t=>{
  const f=fixture(t);f.journal.data.lifecycle='attaching';f.journal.save();
  const env=await setupCli(t,f);const log=join(f.dir,'rpc.jsonl');env.REVIEW_LOG=log;f.journal.close();
  assert.equal((await cli(['run',f.dir],env)).code,1);
  assert.equal(Journal.read(f.dir).lifecycle,'uncertain');
  assert.equal((await cli(['reconcile',f.dir],env)).code,0);
  assert.equal(Journal.read(f.dir).lifecycle,'uncertain');
  assert.equal((await cli(['reconcile',f.dir,'--lifecycle'],env)).code,1);
  const recovered=await cli(['reconcile',f.dir,'--lifecycle','--exclusive'],env);
  assert.equal(recovered.code,0,recovered.output);
  const state=Journal.read(f.dir);assert.equal(state.lifecycle,'ready');
  assert.equal(state.lifecycle_checks.length,1);assert.equal(state.lifecycle_checks[0].thread_id,state.thread_id);
  let calls=readFileSync(log,'utf8');assert.doesNotMatch(calls,/thread\/resume|thread\/start|turn\/start/);
  const retry=await cli(['run',f.dir],env);assert.equal(retry.code,0,retry.output);
  calls=readFileSync(log,'utf8');assert.equal(calls.match(/turn\/start/g).length,1);
});

for(const status of ['failed','interrupted']){
  test(`R4 rearm after historical ${status} preserves history and returns current success`,async t=>{
    const f=fixture(t);await f.coordinator.run();const old=f.journal.data.notifications[0];old.status=status;old.final_status=status;
    f.journal.save();const next={...snapshot(),revision:2,run:{id:'next-run'}};
    const env=await setupCli(t,f,next);const path=join(f.dir,'binding.json');
    writeFileSync(path,JSON.stringify({...f.config.binding,revision:2,run_id:'next-run'}),{mode:0o600});f.journal.close();
    assert.equal((await cli(['rearm',f.dir,path],env)).code,0);
    const result=await cli(['run',f.dir],env);assert.equal(result.code,0,result.output);
    const state=Journal.read(f.dir);assert.deepEqual(state.notifications.map(n=>n.status),[status,'completed']);
    assert.equal(state.stats.attempts,2);
  });
}

async function until(predicate){
  const end=Date.now()+8000;
  while(!predicate()){if(Date.now()>end)throw new Error('fixture_wait_timeout');await new Promise(r=>setTimeout(r,20));}
}
for(const failure of ['timeout','disconnect']){
  test(`R3 CLI stop during history ${failure} preserves receipt and releases owned resources`,{timeout:40000},async t=>{
    const f=fixture(t);const env=await setupCli(t,f);
    Object.assign(env,{REVIEW_HISTORY_FAILURE:failure,REVIEW_WAITING:join(f.dir,'waiting'),REVIEW_RELEASE:join(f.dir,'release'),REVIEW_LOG:join(f.dir,'rpc.jsonl')});
    f.journal.close();const running=cli(['run',f.dir],env);
    await until(()=>existsSync(env.REVIEW_WAITING));
    assert.equal((await cli(['stop',f.dir],env)).code,0);
    await until(()=>Journal.read(f.dir).mode==='stopping');
    writeFileSync(env.REVIEW_RELEASE,'release');const result=await running;
    assert.equal(result.code,1,result.output);
    const state=Journal.read(f.dir);assert.equal(state.mode,'stop_incomplete');
    assert.equal(state.notifications[0].status,'sent');assert.equal(state.notifications[0].turn_id,'current-turn');
    assert.equal(state.error,failure==='timeout'?'codex_receipt_timeout':'codex_disconnected');
    assert.equal(state.stats.attempts,1);assert.equal(existsSync(join(f.dir,'owner.json')),false);
    const records=readFileSync(env.REVIEW_LOG,'utf8').trim().split('\n').map(s=>JSON.parse(s));
    assert.equal(records.filter(r=>r.method==='turn/start').length,1);
    assert.equal(records.at(-1).event,'exit');assert.throws(()=>process.kill(records[0].pid,0),{code:'ESRCH'});
    assert.equal(readdirSync(f.dir).some(name=>name.startsWith('stop-')),false);
  });
}

test('R2 uncertain sends prevent lifecycle recovery and are never replayed',async t=>{
  const f=fixture(t);f.journal.data.lifecycle='uncertain';
  f.journal.data.notifications.push({key:'unknown',marker:'unknown-marker',source_cursor:0,status:'uncertain'});f.journal.save();
  const env=await setupCli(t,f);env.REVIEW_LOG=join(f.dir,'rpc.jsonl');f.journal.close();
  const result=await cli(['reconcile',f.dir,'--lifecycle','--exclusive'],env);
  assert.equal(result.code,1);assert.match(result.output,/unresolved_send/);
  const state=Journal.read(f.dir);assert.equal(state.lifecycle,'uncertain');assert.equal(state.notifications[0].status,'uncertain');
  assert.doesNotMatch(readFileSync(env.REVIEW_LOG,'utf8'),/thread\/resume|thread\/start|turn\/start/);
});

test('R3 local wait abort stops normally but unrelated bridge errors stay visible',async t=>{
  const {BridgeReader}=await import('../src/coordinator/bridge.js');
  const f=fixture(t);f.bridge.task=snapshot('running');
  const abort=new AbortController();let close=0;
  const reader=new BridgeReader(f.dir,async()=>({callTool:()=>new Promise(()=>{}),close:async()=>{close++;}}));
  const wait=reader.read('task_wait',{},abort.signal);setImmediate(()=>abort.abort());
  await assert.rejects(wait,/wait_stopped/);assert.equal(close,1);
  const failed=new BridgeReader(f.dir,async()=>({callTool:async()=>{throw new Error('fixture_history_error');},close:async()=>{}}));
  await assert.rejects(failed.read('task_wait',{},abort.signal),/wait_stopped/);
  f.bridge.read=async(name)=>{
    if(name==='bridge_health')return {...f.config.binding,profile:'desktop'};
    if(name==='task_get')return f.bridge.task;
    f.coordinator.stop();throw new Error('bridge_unavailable_or_invalid_response');
  };
  await assert.rejects(f.coordinator.run(),/bridge_unavailable/);assert.equal(f.journal.data.mode,'stop_incomplete');
});

test('R3 stopping does not swallow a journal failure after a saved send receipt',async t=>{
  const f=fixture(t);const start=f.codex.start;
  f.codex.start=async(...args)=>{const r=await start(...args);f.coordinator.stop();return r;};
  f.codex.history=async()=>{f.journal.hooks.beforeSave=()=>{throw new Error('fixture_disk_failure');};return f.codex.turns;};
  await assert.rejects(f.coordinator.run(),/journal_write_failed/);
  assert.equal(f.journal.failed,true);const state=Journal.read(f.dir);
  assert.equal(state.notifications[0].status,'sent');assert.equal(state.notifications[0].turn_id,'turn-1');
  assert.equal(f.codex.starts.length,1);
});
