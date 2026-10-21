import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../src/tasks.js';
import { listenHealth } from '../src/server.js';
import { simulatedNative, taskSpec } from './support/native.js';
import { BridgeReader } from '../src/coordinator/bridge.js';
import { Journal, initialState } from '../src/coordinator/store.js';
import { Coordinator } from '../src/coordinator/coordinator.js';
import { EventEmitter } from 'node:events';
test('A01 real HTTP MCP: two full 25000ms timeouts plus ordinary progress start zero model turns', {timeout:65000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'event-longwait-'));const workspace=join(dir,'workspace');mkdirSync(workspace);
 const identity={instance_id:'integration',runtime_id:'runtime',profile:'desktop'};
 const native=simulatedNative(dir,workspace);const manager=new TaskManager(native,identity,{stateDir:join(dir,'bridge-ledger')});
 const task=await manager.call('task_submit',taskSpec(workspace));native.begin();
 const token='a'.repeat(64);const server=await listenHealth({port:0,token,readHealth:()=>identity,tasks:manager});
 const bridgeDir=join(dir,'connection');mkdirSync(bridgeDir,{mode:0o700});writeFileSync(join(bridgeDir,'connection.json'),JSON.stringify({url:server.url,token}),{mode:0o600});
 const binding={...identity,task_id:task.task_id,run_id:task.run.id,revision:task.revision};delete binding.profile;
 const journal=new Journal(join(dir,'coordinator'),initialState({binding,bridge_dir:bridgeDir,cwd:workspace,title:'fixture'}));journal.data.lifecycle='ready';journal.data.thread_id='dedicated-thread';journal.save();
 const bridge=new BridgeReader(bridgeDir);const codex=new EventEmitter();let starts=0;codex.start=async()=>{starts++;throw new Error('unexpected_start');};codex.read=async()=>({id:'dedicated-thread',status:{type:'idle'}});
 const c=new Coordinator(journal,bridge,codex);const begin=Date.now();
 // Wait for the server's long poll before emitting progress. A startup timer
 // can fire before the coordinator takes its baseline on a slower runner.
 const wait=manager.wait.bind(manager);let progressSent=false;
 manager.wait=(...args)=>{const pending=wait(...args);if(!progressSent&&manager.waiters.get(task.task_id)?.size){progressSent=true;native.emit('assistant/message',{turn:1,message:{content:[{type:'text',text:'ordinary progress'}]}});}return pending;};
 // Program callbacks observe test progress; no model or timers wake a model.
 const original=bridge.read.bind(bridge);bridge.read=async(...args)=>{const result=await original(...args);if(args[0]==='task_wait'&&result.timed_out&&journal.data.stats.timeouts===1)setImmediate(()=>c.stop());return result;};
 try{await c.run();assert.equal(progressSent,true);assert.equal(starts,0);assert.equal(journal.data.stats.timeouts,2);assert.ok(Date.now()-begin>=50000);assert.ok(journal.data.stats.waits>=3);}
 finally{await bridge.close();journal.close();await server.close();await manager.close();rmSync(dir,{recursive:true,force:true});}
});
