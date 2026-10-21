import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexStdio } from '../src/coordinator/codex.js';
const args=['test/support/codex-jsonl.js'];
test('A13 stdio handshake, create with no turn, ownership rejection preserves only code',async()=>{
 const c=new CodexStdio({command:process.execPath,args});
 try{const init=await c.initialize();assert.equal(init.platformOs,'linux');const created=await c.request('thread/start',{cwd:'/tmp'});assert.equal(created.thread.id,'fixture-thread');assert.equal(c.sequence,2);
 await assert.rejects(c.request('thread/resume',{threadId:created.thread.id}),e=>e.message==='codex_rpc_minus_32600');assert.equal((await c.read(created.thread.id)).status.type,'active');}
 finally{await c.close();}
});
test('A13 lifecycle receipt loss is a timeout, never an implicit retry',async()=>{
 const c=new CodexStdio({command:process.execPath,args:[...args,'drop'],timeout:150});try{await c.initialize();await assert.rejects(c.request('thread/start',{}),/receipt_timeout/);assert.equal(c.sequence,2);}finally{await c.close();}
});
test('A17 server approvals are surfaced without a reply or model restart',async()=>{
 const c=new CodexStdio({command:process.execPath,args});try{await c.initialize();const approval=new Promise(resolve=>c.once('approval',resolve));await c.start('fixture-thread','fixture review');assert.deepEqual(await approval,{method:'item/permissions/requestApproval',id:999});assert.equal(c.sequence,2);}finally{await c.close();}
});
test('A14 actual stdio child disconnect fails closed without another lifecycle request',async()=>{
 const c=new CodexStdio({command:process.execPath,args});try{await c.initialize();const exited=new Promise(resolve=>c.child.once('exit',resolve));c.child.kill('SIGKILL');await exited;await assert.rejects(c.read('fixture-thread'),/codex_disconnected/);assert.equal(c.sequence,1);}finally{await c.close();}
});
