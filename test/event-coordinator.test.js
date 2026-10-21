import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Journal } from '../src/coordinator/store.js';
import { Coordinator } from '../src/coordinator/coordinator.js';
import { BridgeReader, validatePage } from '../src/coordinator/bridge.js';
import { readReviewBundle } from '../src/coordinator/review.js';
import { fixture, snapshot } from './support/coordinator-fixture.js';

test('A02 A03 completion, durable dedup across reconnect/restart and rearm of same binding',async t=>{
  const f=fixture(t);await f.coordinator.run();assert.equal(f.codex.starts.length,1);assert.equal(f.journal.data.notifications[0].status,'completed');
  for(let i=0;i<5;i++)await f.coordinator.run();
  f.journal.close();const reopened=new Journal(f.dir);t.after(()=>reopened.close());
  reopened.data.cursor=null;reopened.save();await new Coordinator(reopened,f.bridge,f.codex).run();
  assert.equal(f.codex.starts.length,1);assert.equal(reopened.data.stats.attempts,1);assert.match(reopened.data.notifications[0].result,/建议通过/);
});
test('A04 busy then idle rechecks current snapshot before exactly one send',async t=>{
 const f=fixture(t);let reads=0;f.codex.read=async()=>({id:'dedicated-thread',status:{type:++reads===1?'active':'idle'}});
 await f.coordinator.run();assert.equal(reads,2);assert.equal(f.codex.starts.length,1);assert.ok(f.bridge.calls.filter(x=>x.name==='task_get').length>=3);
});
test('A05 pending busy event superseded by another run',async t=>{
 const f=fixture(t,{pause:async()=>{f.bridge.task.run.id='new-run';}});f.codex.read=async()=>({id:'dedicated-thread',status:{type:'active'}});
 await assert.rejects(f.coordinator.run(),/binding_changed/);assert.equal(f.codex.starts.length,0);assert.equal(f.journal.data.notifications[0].status,'superseded');
});
test('A06 waiting approval delays locally; human approval fixture can complete; denial is visible',async t=>{
 let pauses=0;const f=fixture(t,{pause:async()=>{pauses++;f.bridge.task=snapshot();}});f.bridge.task=snapshot('waiting_approval');
 f.bridge.read=async(name,args)=>{f.bridge.calls.push({name,args});if(name==='bridge_health')return {...f.config.binding,profile:'desktop'};if(name==='task_get')return structuredClone(f.bridge.task);if(name==='task_wait')return {task:structuredClone(f.bridge.task),items:[],next_cursor:0,has_more:false,timed_out:false};};
 await f.coordinator.run();assert.equal(pauses,1);assert.equal(f.codex.starts.length,1);assert.ok(f.bridge.calls.every(x=>['bridge_health','task_get','task_wait'].includes(x.name)));
 const denied=fixture(t);denied.bridge.task={...snapshot('failed'),status_detail:{permission_denied:true}};await denied.coordinator.run();assert.equal(denied.codex.starts.length,0);assert.equal(denied.journal.data.error,'native_permission_denied');
});
test('A07 event pages commit cursor and pending together; tail is never used as consumed cursor',async t=>{
 const f=fixture(t);f.bridge.task=snapshot('running');let page=0;
 const original=f.bridge.read.bind(f.bridge);f.bridge.read=async(name,args)=>{
 if(name!=='task_wait')return original(name,args);
 assert.equal(args.cursor,page);page++;f.bridge.task={...snapshot(),event_cursor:2};
 return {task:f.bridge.task,items:[{cursor:page}],next_cursor:page,has_more:page<2,timed_out:false};};
 await f.coordinator.run();assert.equal(page,2);assert.equal(f.journal.data.cursor,2);assert.equal(f.codex.starts.length,1);
 assert.throws(()=>validatePage({items:[{cursor:4}],next_cursor:4,has_more:false},2,4),/cursor_gap/);
});
test('A07 all evidence pages and witness/truncation flags preserved; gaps rejected',async t=>{
 const f=fixture(t);f.bridge.task.evidence_cursor=52;f.bridge.task.run.evidence_start=1;
 const original=f.bridge.read.bind(f.bridge);f.bridge.read=async(name,args)=>{
 if(name!=='task_evidence')return original(name,args);
 const start=args.cursor===0?1:args.cursor;const end=Math.min(start+50,52);
 return {run_id:'run',items:Array.from({length:end-start},(_,i)=>({cursor:start+i+1,id:`e-${start+i+1}`,run_id:'run',truncated:true})),next_cursor:end,has_more:end<52,artifacts:{valid:false}};};
 const bundle=await readReviewBundle(f.bridge,f.config.binding);assert.equal(bundle.evidence.length,51);assert.equal(bundle.pages.length,2);assert.equal(bundle.pages[0].artifacts.valid,false);assert.equal(bundle.evidence[0].truncated,true);
 f.bridge.task.run.evidence_start=0;await assert.rejects(readReviewBundle(f.bridge,f.config.binding),/evidence_cursor_gap/);
});
test('A08 runtime change fences; bridge reader refuses all writes',async t=>{
 const f=fixture(t);f.bridge.task.runtime_id='new-runtime';await assert.rejects(f.coordinator.run(),/runtime_changed/);assert.equal(f.codex.starts.length,0);
 const reader=new BridgeReader(f.dir);for(const name of ['task_review','task_continue','task_cancel','task_recover','task_submit'])await assert.rejects(reader.read(name),/bridge_write_forbidden/);
});
test('A09 write failure before attempted prevents external call and fences owner',async t=>{
 let blocked=false;const f=fixture(t,{hooks:{beforeSave:s=>{if(blocked&&s.notifications.some(n=>n.status==='attempted'))throw new Error('disk');}}});blocked=true;
 await assert.rejects(f.coordinator.run(),/journal_write_failed/);assert.equal(f.codex.starts.length,0);assert.throws(()=>f.journal.save(),/journal_fenced/);
});
test('A10 receipt lost stays uncertain on restart; unique official history repairs it without resending',async t=>{
 const f=fixture(t);const real=f.codex.start;f.codex.start=async(...args)=>{await real(...args);throw new Error('codex_receipt_timeout');};
 await f.coordinator.run();assert.equal(f.journal.data.notifications[0].status,'uncertain');
 f.journal.close();const j=new Journal(f.dir);t.after(()=>j.close());const c=new Coordinator(j,f.bridge,f.codex);const saved=f.codex.turns;f.codex.turns=[];
 await assert.rejects(c.run(),/uncertain_send/);assert.equal(f.codex.starts.length,1);
 f.codex.turns=saved;await c.reconcile();assert.equal(j.data.notifications[0].status,'completed');assert.equal(j.data.notifications[0].turn_id,'turn-1');
});
test('A12 lock refuses live, corrupted, reused PID and old nonce cannot remove new owner',t=>{
 const f=fixture(t);assert.throws(()=>new Journal(f.dir),/already_owned/);
 const lock=join(f.dir,'owner.json');const owner=JSON.parse(readFileSync(lock));writeFileSync(lock,JSON.stringify({...owner,nonce:'11111111-1111-4111-8111-111111111111',start:'9999999'}));
 f.journal.close();assert.ok(existsSync(lock));assert.throws(()=>new Journal(f.dir),/already_owned/);
 writeFileSync(lock,'{}');assert.throws(()=>new Journal(f.dir),/lock_corrupt/);
});
test('journal rejects checksum, schema, insecure files and symlink state paths',t=>{
 const f=fixture(t);f.journal.close();const file=join(f.dir,'state.json');const bytes=readFileSync(file);
 writeFileSync(file,'{"data":{},"checksum":"x"}');assert.throws(()=>Journal.read(f.dir),/checksum/);writeFileSync(file,bytes);chmodSync(file,0o644);assert.throws(()=>Journal.read(f.dir),/unsafe_state/);chmodSync(file,0o600);
 const link=join(f.dir,'linked');symlinkSync(f.dir,link);assert.throws(()=>new Journal(link),/symlink/);
});
test('A14 bridge read reconnect uses bounded local backoff; stable connection resumes; raw errors sanitized',async t=>{
 const pauses=[];const f=fixture(t,{pause:async ms=>pauses.push(ms)});const read=f.bridge.read.bind(f.bridge);let count=0;f.bridge.read=async(...args)=>{if(++count<4)throw new Error('bridge_unavailable_or_invalid_response');return read(...args);};await f.coordinator.run();assert.deepEqual(pauses,[1000,2000,4000]);assert.equal(f.codex.starts.length,1);
 const broken=fixture(t);broken.codex.read=async()=>{throw new Error('secret provider body');};await assert.rejects(broken.coordinator.run());assert.equal(broken.journal.data.error,'operation_failed_check_local_environment');
});
test('A15 stop while idle prevents sending; stop active review drains completion without cancel',async t=>{
 const f=fixture(t);f.coordinator.stop();await f.coordinator.run();assert.equal(f.codex.starts.length,0);
 const active=fixture(t);const start=active.codex.start;active.codex.start=async(...a)=>{const r=await start(...a);active.coordinator.stop();return r;};await active.coordinator.run();assert.equal(active.journal.data.notifications[0].status,'completed');assert.equal(active.journal.data.mode,'stopped');assert.ok(active.bridge.calls.every(x=>!x.name.includes('cancel')));
});
test('A16 new explicit run/revision preserves old dedup and can produce a distinct review',async t=>{
 const f=fixture(t);await f.coordinator.run();f.config.binding.run_id='run-2';f.config.binding.revision=2;f.journal.data.config.binding={...f.config.binding};f.journal.data.cursor=null;f.bridge.task={...snapshot(),revision:2,run:{id:'run-2',evidence_start:0}};await f.coordinator.run();assert.equal(f.codex.starts.length,2);assert.equal(f.journal.data.notifications.length,2);assert.notEqual(f.journal.data.notifications[0].key,f.journal.data.notifications[1].key);
});
for(const status of ['failed','interrupted'])test(`A17 ${status} turn is not completed and is never restarted`,async t=>{
 const f=fixture(t);const start=f.codex.start;f.codex.start=async(...args)=>{const r=await start(...args);f.codex.turns[0].status=status;return r;};await f.coordinator.run();await f.coordinator.run();assert.equal(f.journal.data.notifications[0].status,status);assert.equal(f.codex.starts.length,1);
});
test('A17 approval request is recorded without sending any response',t=>{
 const f=fixture(t);f.codex.emit('approval',{method:'item/permissions/requestApproval',id:1});assert.equal(f.journal.data.mode,'codex_approval_required');assert.equal(f.codex.starts.length,0);
});
for(const window of ['attempted','receipt'])test(`A11 A12 real process killed in ${window} window; dead owner reclaimed and no replay`,async t=>{
 const f=fixture(t);f.journal.close();
 const child=spawn(process.execPath,['test/support/coordinator-crash.js',f.dir,window],{stdio:['ignore','pipe','pipe','ipc']});
 const message=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw new Error(`child_exit_${code}`);})]);assert.equal(message[0].stage,window);
 child.kill('SIGKILL');await once(child,'exit');
 assert.equal(existsSync(join(f.dir,'external-send.json')),window==='receipt');
 const j=new Journal(f.dir);t.after(()=>j.close());assert.equal(j.data.notifications[0].status,'uncertain');
 const c=new Coordinator(j,f.bridge,f.codex);await assert.rejects(c.run(),/uncertain_send/);assert.equal(j.data.notifications[0].status,'uncertain');assert.equal(f.codex.starts.length,0);
});
test('A14 repeated task_wait failures stop after five bounded backoffs',async t=>{
 const pauses=[];const f=fixture(t,{pause:async ms=>pauses.push(ms)});f.bridge.task=snapshot('running');const read=f.bridge.read.bind(f.bridge);f.bridge.read=async(name,...args)=>{if(name==='task_wait')throw new Error('bridge_unavailable_or_invalid_response');return read(name,...args);};await assert.rejects(f.coordinator.run(),/bridge_unavailable/);assert.deepEqual(pauses,[1000,2000,4000,8000,16000]);assert.equal(f.codex.starts.length,0);
});
test('A05 state changes between idle check and send supersede pending without calling start',async t=>{
 const f=fixture(t);f.codex.read=async()=>{f.bridge.task=snapshot('cancelled');return {id:'dedicated-thread',status:{type:'idle'}};};await f.coordinator.run();assert.equal(f.journal.data.notifications[0].status,'superseded');assert.equal(f.codex.starts.length,0);
});
test('A12 two actual processes cannot own the same journal',async t=>{
 const f=fixture(t);f.journal.close();
 const child=spawn(process.execPath,['test/support/coordinator-lock.js',f.dir],{stdio:['ignore','pipe','pipe','ipc']});t.after(()=>child.kill());
 assert.equal((await once(child,'message'))[0].owned,true);
 const contender=spawn(process.execPath,['test/support/coordinator-lock.js',f.dir],{stdio:['ignore','pipe','pipe','ipc']});t.after(()=>contender.kill());
 const exited=once(contender,'exit');assert.equal((await once(contender,'message'))[0].owned,false);assert.equal((await exited)[0],1);
 const released=once(child,'exit');child.send({release:true});assert.equal((await released)[0],0);
 const j=new Journal(f.dir);j.close();
});
test('A09 receipt commit failure leaves attempted on disk; reopen makes it uncertain and never resends',async t=>{
 const f=fixture(t,{hooks:{beforeSave:s=>{if(s.notifications.some(n=>n.status==='sent'))throw new Error('disk_full');}}});
 await assert.rejects(f.coordinator.run(),/journal_write_failed/);assert.equal(f.codex.starts.length,1);assert.equal(f.journal.failed,true);f.journal.close();const j=new Journal(f.dir);t.after(()=>j.close());assert.equal(j.data.notifications[0].status,'uncertain');
 f.codex.turns=[];await assert.rejects(new Coordinator(j,f.bridge,f.codex).run(),/uncertain_send/);assert.equal(f.codex.starts.length,1);
});
test('A10 nonunique history and marker in assistant text never repair an uncertain send',async t=>{
 const f=fixture(t);f.codex.start=async()=>{throw new Error('codex_receipt_timeout');};await f.coordinator.run();const notice=f.journal.data.notifications[0];
 f.codex.turns=[{id:'assistant-only',status:'completed',items:[{type:'agentMessage',text:notice.marker}]}];await f.coordinator.reconcile();assert.equal(notice.status,'uncertain');
 f.codex.turns=['one','two'].map(id=>({id,status:'completed',items:[{type:'userMessage',content:[{type:'text',text:notice.marker}]}]}));await f.coordinator.reconcile();assert.equal(notice.status,'uncertain');
});
test('A02 durable sent receipt survives history propagation delay without another start',async t=>{
 let histories=0;const f=fixture(t,{pause:async()=>{}});const real=f.codex.history;f.codex.history=async()=>++histories===1?[]:real();await f.coordinator.run();assert.equal(histories,2);assert.equal(f.codex.starts.length,1);assert.equal(f.journal.data.notifications[0].status,'completed');
});
test('A15 lost receipt with active review is drained through unique history, not interrupted',async t=>{
 const f=fixture(t);let reads=0;f.codex.read=async()=>({id:'dedicated-thread',status:{type:++reads===1?'idle':'active'}});const real=f.codex.start;f.codex.start=async(...a)=>{await real(...a);throw new Error('codex_receipt_timeout');};await f.coordinator.run();assert.equal(f.journal.data.notifications[0].status,'completed');assert.equal(f.codex.starts.length,1);
});
test('A07 expired cursor stops at last durable cursor; malformed lock acquisition guard fails closed',async t=>{
 const f=fixture(t);f.bridge.task=snapshot('running');const read=f.bridge.read.bind(f.bridge);f.bridge.read=async(name,...args)=>{if(name==='task_wait')throw new Error('cursor_expired_inspect_DSH');return read(name,...args);};await assert.rejects(f.coordinator.run(),/cursor_expired/);assert.equal(f.journal.data.cursor,0);assert.equal(f.codex.starts.length,0);
 f.journal.close();writeFileSync(join(f.dir,'acquiring'),'stale-unknown',{mode:0o600});assert.throws(()=>new Journal(f.dir),/lock_acquisition_manual/);
});
test('A03 A07 resumed review drains unread pages before any send',async t=>{
 const f=fixture(t);f.journal.data.cursor=0;f.journal.data.baseline_cursor=0;f.journal.save();f.bridge.task={...snapshot(),event_cursor:2};
 const read=f.bridge.read.bind(f.bridge);let pages=0;f.bridge.read=async(name,args)=>{
  if(name!=='task_wait')return read(name,args);
  assert.equal(args.cursor,pages);assert.equal(args.timeout_ms,0);assert.equal(f.codex.starts.length,0);pages++;
  return {task:structuredClone(f.bridge.task),items:[{cursor:pages}],next_cursor:pages,has_more:pages<2,timed_out:false};
 };
 const start=f.codex.start;f.codex.start=async(...args)=>{assert.equal(pages,2);return start(...args);};
 await f.coordinator.run();assert.equal(pages,2);assert.equal(f.journal.data.cursor,2);assert.equal(f.codex.starts.length,1);
});
test('A03 A07 resumed pending review cannot bypass an expired event cursor',async t=>{
 const f=fixture(t);f.journal.data.cursor=1;f.journal.data.baseline_cursor=1;await f.coordinator.observe({...snapshot(),event_cursor:1});
 f.bridge.task={...snapshot(),event_cursor:400};const read=f.bridge.read.bind(f.bridge);f.bridge.read=async(name,...args)=>{
  if(name==='task_wait')throw new Error('cursor_expired_inspect_DSH');return read(name,...args);
 };
 await assert.rejects(f.coordinator.run(),/cursor_expired/);assert.equal(f.journal.data.cursor,1);assert.equal(f.journal.data.stats.attempts,0);assert.equal(f.codex.starts.length,0);
});
test('A07 event tail advancing at final send check is consumed before attempting',async t=>{
 const f=fixture(t);let targetReads=0,pages=0;f.codex.read=async()=>{
  if(++targetReads===1)f.bridge.task={...snapshot(),event_cursor:2};return {id:'dedicated-thread',status:{type:'idle'}};
 };
 const read=f.bridge.read.bind(f.bridge);f.bridge.read=async(name,args)=>{
  if(name!=='task_wait')return read(name,args);pages++;assert.equal(args.cursor,0);assert.equal(args.timeout_ms,0);
  return {task:structuredClone(f.bridge.task),items:[{cursor:1},{cursor:2}],next_cursor:2,has_more:false,timed_out:false};
 };
 const start=f.codex.start;f.codex.start=async(...args)=>{assert.equal(pages,1);return start(...args);};
 await f.coordinator.run();assert.equal(pages,1);assert.equal(f.journal.data.cursor,2);assert.equal(f.codex.starts.length,1);
});
test('A08 A17 terminal cause codes distinguish known native failures without exposing provider text',async t=>{
 for(const example of [
  {state:'failed',detail:{category:'model_or_execution_error'},reason:'native_error_check_DSH',expected:'native_model_or_execution_error'},
  {state:'needs_human',detail:{category:'needs_human'},reason:'unexpected_native_input_check_DSH',expected:'unexpected_native_input_check_dsh'},
  {state:'failed',detail:{category:'private_provider_response'},reason:'secret provider error body',expected:'native_task_requires_human_check'},
 ]){
  const f=fixture(t);f.bridge.task={...snapshot(example.state),status_detail:example.detail,reason:example.reason};
  await f.coordinator.run();assert.equal(f.journal.data.error,example.expected);assert.equal(f.codex.starts.length,0);assert.doesNotMatch(JSON.stringify(f.journal.data),/secret provider|private_provider_response/);
 }
});
