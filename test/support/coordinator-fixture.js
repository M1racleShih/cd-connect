import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal, initialState } from '../../src/coordinator/store.js';
import { Coordinator } from '../../src/coordinator/coordinator.js';
export const binding = {instance_id:'fixture-instance',runtime_id:'fixture-runtime',task_id:'task',run_id:'run',revision:1};
export const snapshot = (state='awaiting_review') => ({...binding,run:{id:'run',evidence_start:0},state,event_cursor:0,evidence_cursor:0,spec:{workspace:'/tmp/example'}});
export function fixture(t, options={}){
  const dir=mkdtempSync(join(tmpdir(),'event-coordinator-'));
  const config={binding:{...binding},bridge_dir:dir,cwd:dir,title:'fixture'};
  const journal=new Journal(dir,initialState(config),options.hooks);
  journal.data.thread_id='dedicated-thread';journal.data.lifecycle='ready';journal.save();
  const codex=new EventEmitter();codex.starts=[];codex.turns=[];
  codex.read=async()=>({id:'dedicated-thread',status:{type:'idle'}});
  codex.start=async(_,text)=>{codex.starts.push(text);const turn={id:'turn-1',status:'completed',items:[{type:'userMessage',content:[{type:'inputText',text}]},{type:'agentMessage',text:'建议通过 evidence-1'}]};codex.turns.push(turn);return {...turn,status:'inProgress'};};
  codex.history=async()=>codex.turns;
  const bridge={task:snapshot(),calls:[],async read(name,args){this.calls.push({name,args});if(name==='bridge_health')return {...binding,profile:'desktop'};if(name==='task_get')return structuredClone(this.task);throw new Error('unexpected_bridge_call');}};
  const coordinator=new Coordinator(journal,bridge,codex,{pause:async()=>{},...options});
  t.after(()=>{journal.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,config,journal,codex,bridge,coordinator};
}
