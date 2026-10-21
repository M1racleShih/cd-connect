#!/usr/bin/env node
import { existsSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Journal, initialState, readPrivate } from '../src/coordinator/store.js';
import { configSchema, bindingSchema, ownerSchema, effectiveSchema, safeCode, fail } from '../src/coordinator/schema.js';
import { BridgeReader } from '../src/coordinator/bridge.js';
import { CodexStdio } from '../src/coordinator/codex.js';
import { Coordinator } from '../src/coordinator/coordinator.js';
import { notificationKey } from '../src/coordinator/review.js';
const [command, dir, ...args]=process.argv.slice(2);
let store,reader,codex,timer,coordinator;
async function attach(){
  if(store.data.lifecycle!=='ready')fail('thread_lifecycle_manual_check_required');
  codex=new CodexStdio();await codex.initialize();
  const target=await codex.read(store.data.thread_id);
  if(target.id!==store.data.thread_id)fail('codex_thread_mismatch');
  await codex.history(store.data.thread_id);
  store.data.lifecycle='attaching';store.save();
  let r;
  try { r=await codex.request('thread/resume',{threadId:store.data.thread_id}); }
  catch(e){store.data.lifecycle=e.message==='codex_rpc_minus_32600'?'ready':'uncertain';store.data.error=safeCode(e);store.save();throw e;}
  if(r.thread?.id!==store.data.thread_id)fail('codex_thread_mismatch');
  store.data.effective=effectiveSchema.parse(r);store.data.lifecycle='ready';store.save();
  return r;
}
try{
  if(!dir || !['init','run','status','stop','rearm','reconcile'].includes(command))fail('usage_event_coordinator_command_state_directory');
  if(command==='status')console.log(JSON.stringify(Journal.read(dir),null,2));
  else if(command==='stop'){
    Journal.read(dir);const owner=ownerSchema.parse(readPrivate(join(dir,'owner.json')));
    const path=join(dir,`stop-${owner.nonce}.json`);
    if(!existsSync(path)){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify({nonce:owner.nonce}));}finally{closeSync(fd);}}
    console.log('stop_requested_drains_active_review_no_dsh_cancellation');
  }else if(command==='init'){
    if(!((args.length===3 && args[1]==='--create' && args[2]==='--exclusive') || (args.length===4 && args[1]==='--thread' && args[3]==='--exclusive')))fail('usage_init_state_config_create_or_thread_id_exclusive');
    const config=configSchema.parse(readPrivate(args[0]));
    if(existsSync(join(dir,'state.json')))fail('journal_already_exists');
    store=new Journal(dir,initialState(config));reader=new BridgeReader(config.bridge_dir);
    codex=new CodexStdio();await codex.initialize();coordinator=new Coordinator(store,reader,codex);
    await coordinator.snapshot();
    store.data.lifecycle=args[1]==='--create'?'creating':'attaching';
    if(args[1]==='--thread')store.data.thread_id=args[2];
    store.save();
    try{
      const r=await codex.request(args[1]==='--create'?'thread/start':'thread/resume',args[1]==='--create'?{cwd:config.cwd}:{threadId:args[2]});
      if(typeof r.thread?.id!=='string' || typeof r.model!=='string' || typeof r.cwd!=='string')fail('codex_invalid_thread_receipt');
      store.data.thread_id=r.thread.id;
      store.data.effective=effectiveSchema.parse(r);store.save();
      await codex.request('thread/name/set',{threadId:r.thread.id,name:config.title});
      store.data.lifecycle='ready';store.save();
    }catch(e){store.data.lifecycle='uncertain';store.data.error=safeCode(e);if(!store.failed)store.save();throw e;}
    console.log(JSON.stringify({thread_id:store.data.thread_id,effective:store.data.effective,model_turns_started:0}));
  }else{
    store=new Journal(dir);
    if(command==='rearm'){
      if(args.length!==1)fail('usage_rearm_state_binding_json');
      if(store.data.notifications.some(n=>['attempted','uncertain','sent'].includes(n.status)))fail('unresolved_send_reconcile_first');
      const binding=bindingSchema.parse(readPrivate(args[0]));const before=store.data.config.binding;
      store.data.config.binding=binding;reader=new BridgeReader(store.data.config.bridge_dir);
      coordinator=new Coordinator(store,reader,{});
      try{await coordinator.snapshot();}catch(e){store.data.config.binding=before;throw e;}
      const same=Object.keys(before).every(key=>before[key]===binding[key]);
      if(!same){store.data.cursor=null;store.data.baseline_cursor=null;}
      store.data.mode='rearmed';store.data.error=null;store.save();
      console.log('rearmed_history_retained');
    }else{
      if(command==='reconcile'){codex=new CodexStdio();await codex.initialize();if(!store.data.thread_id)fail('creation_identity_manual_check_required');}
      else await attach();reader=new BridgeReader(store.data.config.bridge_dir);coordinator=new Coordinator(store,reader,codex);
      if(command==='reconcile'){
        if(args.length && (args.length!==2 || args[0]!=='--lifecycle' || args[1]!=='--exclusive'))fail('usage_reconcile_state_lifecycle_exclusive');
        await coordinator.reconcile();
        if(args.length){
          if(store.data.lifecycle!=='uncertain')fail('lifecycle_not_uncertain');
          const target=await codex.read(store.data.thread_id);
          if(target.id!==store.data.thread_id)fail('codex_thread_mismatch');
          if(!['idle','notLoaded'].includes(target.status.type))fail('lifecycle_target_not_idle');
          const history=await codex.history(store.data.thread_id);
          if(history.some(t=>t.status==='inProgress') || store.data.notifications.some(n=>['attempted','uncertain','sent'].includes(n.status)))fail('unresolved_send_reconcile_first');
          (store.data.lifecycle_checks??=[]).push({thread_id:target.id,checked_at:new Date().toISOString(),status:target.status.type,previous_error:store.data.error});
          store.data.lifecycle='ready';store.data.mode='lifecycle_reconciled';store.data.error=null;store.save();
        }
        console.log(JSON.stringify(store.data.notifications,null,2));
      }
      else{
        const stopPath=join(dir,`stop-${store.owner.nonce}.json`);
        const stop=()=>{if(!coordinator.stopping)coordinator.stop();};
        process.on('SIGTERM',stop);process.on('SIGINT',stop);
        timer=setInterval(()=>{if(existsSync(stopPath)&&readPrivate(stopPath).nonce===store.owner.nonce)stop();},250);
        try{await coordinator.run();if(store.data.notifications.some(n=>['attempted','uncertain','sent'].includes(n.status) || (n.key===notificationKey(store.data.config.binding) && ['failed','interrupted'].includes(n.status))))process.exitCode=1;}finally{if(existsSync(stopPath))unlinkSync(stopPath);}
        console.log(JSON.stringify({mode:store.data.mode,stats:store.data.stats,notifications:store.data.notifications.map(({key,status,turn_id})=>({key,status,turn_id}))}));
      }
    }
  }
}catch(e){if(store && !store.failed && !store.closed){store.data.error=safeCode(e);store.data.mode=coordinator?.stopping?'stop_incomplete':'paused';try{store.save();}catch{}}console.error(safeCode(e));process.exitCode=1;}
finally{clearInterval(timer);await reader?.close();await codex?.close();store?.close();}
