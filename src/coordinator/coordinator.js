import { setTimeout as delay } from 'node:timers/promises';
import { checkBinding, validatePage } from './bridge.js';
import { snapshotSchema, safeCode, turnSchema, threadSchema, fail } from './schema.js';
import { notificationKey, reviewMessage } from './review.js';
export class Coordinator {
  constructor(store, bridge, codex, { pause = (ms,signal) => delay(ms,undefined,{signal}), delayMs=1000, hook = () => {} } = {}) {
    this.store=store; this.bridge=bridge; this.codex=codex; this.pause=pause; this.delayMs=delayMs; this.hook=hook;
    this.signal = new AbortController();
    codex.on?.('approval', () => { this.store.data.mode='codex_approval_required'; this.store.data.error='native_approval_requires_human_no_automatic_reply'; this.store.save(); });
  }
  get data(){return this.store.data;}
  save(){this.store.save();}
  stop(){this.stopping=true;this.signal.abort();this.data.mode='stopping';this.save();}
  async snapshot(){
    const b=this.data.config.binding;
    const h=await this.bridge.read('bridge_health');
    const t=snapshotSchema.parse(await this.bridge.read('task_get',{task_id:b.task_id}));
    checkBinding(b,h,t);return t;
  }
  async reconcile(){
    const history=(await this.codex.history(this.data.thread_id)).map(t=>turnSchema.parse(t));
    for(const n of this.data.notifications){
      if (!['attempted','uncertain','sent'].includes(n.status)) continue;
      const matches=history.filter(t=>(t.items??[]).some(item=>item?.type==='userMessage' && JSON.stringify(item.content??[]).includes(n.marker)));
      let turn;
      if(n.status==='sent' && n.turn_id){
        // A durable receipt identifies an in-flight turn even before persisted items are visible.
        const identified=history.filter(t=>t.id===n.turn_id);
        if(identified.length===0){n.error='receipt_history_not_yet_visible';continue;}
        if(identified.length!==1 || matches.some(t=>t.id!==n.turn_id)){n.status='uncertain';n.error='receipt_history_conflict_manual_check';continue;}
        turn=identified[0];
      }else{
        if(matches.length!==1 || (n.turn_id && matches[0].id!==n.turn_id)) { n.status='uncertain'; n.error='history_match_not_unique_manual_check'; continue; }
        turn=matches[0];
      }
      n.turn_id=turn.id;
      if(['completed','failed','interrupted'].includes(turn.status)){
        n.status=turn.status;n.final_status=turn.status;n.result=JSON.stringify((turn.items??[]).flatMap(item=>{
          if(item?.type==='agentMessage')return [{type:'agentMessage',text:typeof item.text==='string'?item.text.slice(0,200000):''}];
          if(item?.type==='commandExecution')return [{type:'commandExecution',exitCode:item.exitCode??null,evidence_reader:typeof item.command==='string'&&item.command.includes('event-evidence.js')}];
          return [];
        })); delete n.error;
        this.data.mode=`review_${turn.status}`;this.data.error=turn.status==='completed'?null:`review_turn_${turn.status}`;
      }else n.status='sent';
    }
    this.save();
  }
  async observe(task, sourceCursor){
    this.data.last_state=task.state;
    if(this.data.cursor===null){ this.data.cursor=task.event_cursor; this.data.baseline_cursor=task.event_cursor; }
    const key=notificationKey(this.data.config.binding);
    let n=this.data.notifications.find(n=>n.key===key);
    if(task.state==='awaiting_review' && !n){
      n={key,marker:`cd-connect-review:${key}`,source_cursor:sourceCursor??task.event_cursor,status:'pending'};this.data.notifications.push(n);
    }
    if(n?.status==='pending' && task.state!=='awaiting_review') n.status='superseded';
    this.data.mode=task.state;
    const nativeCause=task.status_detail?.permission_denied ? 'native_permission_denied' :
      task.status_detail?.category==='model_or_execution_error' ? 'native_model_or_execution_error' :
        task.reason==='unexpected_native_input_check_DSH' ? 'unexpected_native_input_check_dsh' : 'native_task_requires_human_check';
    this.data.error=['failed','needs_human','needs_recovery','cancelled'].includes(task.state) ? nativeCause : null;
    this.save();return n;
  }
  async sendPending(n){
    if(this.stopping || n.status!=='pending') return;
    const target=threadSchema.parse(await this.codex.read(this.data.thread_id));
    if(target.id!==this.data.thread_id) fail('codex_thread_mismatch');
    if(target.status.type==='active'){this.data.mode='target_busy';this.save();return 'busy';}
    if(target.status.type!=='idle') fail('codex_target_unavailable');
    // Busy resolution and task revalidation are serialized with sending.
    const task=await this.snapshot();checkBinding(this.data.config.binding,{instance_id:task.instance_id,runtime_id:task.runtime_id},task);
    if(task.state!=='awaiting_review'){n.status='superseded';this.save();return;}
    if(task.event_cursor<this.data.cursor)fail('cursor_gap_manual_check_required');
    if(task.event_cursor!==this.data.cursor)return 'catch_up';
    if(this.stopping)return;
    n.status='attempted';n.attempted_at=new Date().toISOString();this.data.stats.attempts++;this.save();
    this.hook('attempted');
    try {
      const turn=turnSchema.parse(await this.codex.start(this.data.thread_id,reviewMessage(this.data,n,this.store.dir)));
      this.hook('receipt');n.turn_id=turn.id;n.status='sent';this.save();
    }catch(e){
      n.status='uncertain';n.error=safeCode(e);
      if(this.store.failed)throw e;
      this.data.mode='paused';this.data.error='uncertain_send_manual_check_required';this.save();
      return;
    }
  }
  async finish(n){
    // Wait in local code. No model polling and no second turn. Stop drains this turn.
    while(n.status==='sent'){
      await this.reconcile();
      if(n.status==='sent')await this.pause(this.delayMs);
    }
  }
  async drainUnknown(n){
    // Never close a normally reachable active review just because its receipt was lost.
    while(n.status==='uncertain' && !this.codex.dead){
      const target=threadSchema.parse(await this.codex.read(this.data.thread_id));
      if(target.id!==this.data.thread_id)fail('codex_thread_mismatch');
      if(target.status.type!=='active')return;
      await this.reconcile();
      if(n.status==='sent'){await this.finish(n);return;}
      if(n.status==='uncertain')await this.pause(this.delayMs);
    }
  }
  async consumePages(taskId, timeoutMs){
    let more;
    do{
      const page=await this.bridge.read('task_wait',{task_id:taskId,cursor:this.data.cursor,limit:50,timeout_ms:timeoutMs},this.signal.signal);
      const latest=snapshotSchema.parse(page.task);
      validatePage(page,this.data.cursor,latest.event_cursor);
      checkBinding(this.data.config.binding,{instance_id:latest.instance_id,runtime_id:latest.runtime_id},latest);
      // Cursor and event-derived pending state are committed together.
      this.data.cursor=page.next_cursor;this.data.stats.waits++;if(page.timed_out)this.data.stats.timeouts++;
      await this.observe(latest,page.items.at(-1)?.cursor);
      more=page.has_more;
    }while(more&&!this.stopping);
  }
  async run(){
    let failures=0, failed=false;
    const localStop=e=>this.stopping && (e.message==='wait_stopped' || (e.name==='AbortError' && e.code==='ABORT_ERR' && e.cause===this.signal.signal.reason));
    try{
      if(this.data.lifecycle!=='ready')fail('thread_lifecycle_manual_check_required');
      if(this.data.notifications.some(n=>['attempted','uncertain','sent'].includes(n.status)))await this.reconcile();
      if(this.data.notifications.some(n=>n.status==='uncertain'))fail('uncertain_send_manual_check_required');
      const inflight=this.data.notifications.find(n=>n.status==='sent');
      if(inflight){await this.finish(inflight);return;}
      while(!this.stopping){
        try{
          const task=await this.snapshot();
          if(this.data.cursor!==null){
            if(task.event_cursor<this.data.cursor)fail('cursor_gap_manual_check_required');
            if(task.event_cursor>this.data.cursor){await this.consumePages(task.task_id,0);failures=0;continue;}
          }
          const n=await this.observe(task);
          if(n?.status==='pending'){
            const r=await this.sendPending(n);
            if(n.status==='sent')await this.finish(n);
            else if(n.status==='uncertain')await this.drainUnknown(n);
            if(r==='catch_up')continue;
            if(r==='busy'){await this.pause(this.delayMs,this.signal.signal);continue;}
            if(n.status!=='pending')return;
          }
          if(n && ['attempted','uncertain','sent','completed','failed','interrupted'].includes(n.status))return;
          if(['failed','needs_human','needs_recovery','cancelled','accepted','changes_requested'].includes(task.state))return;
          if(task.state==='waiting_approval')await this.pause(this.delayMs,this.signal.signal);
          await this.consumePages(task.task_id,25000);failures=0;
        }catch(e){
          if(localStop(e))break;
          if(this.stopping)throw e;
          if(e.message==='bridge_unavailable_or_invalid_response' && ++failures<=5){
            this.data.mode='bridge_backoff';this.data.error=e.message;this.save();await this.pause(Math.min(1000*2**(failures-1),16000),this.signal.signal);continue;
          }
          throw e;
        }
      }
    }catch(e){
      if(!localStop(e)){
        failed=true;
        if (/^(binding_changed|runtime_changed)/.test(e.message)) for (const n of this.data.notifications) if (n.status==='pending') n.status='superseded';
        this.data.mode=this.stopping?'stop_incomplete':'paused';this.data.error=safeCode(e);if(!this.store.failed)this.save();throw e;
      }
    }finally{
      if(!this.store.failed){if(this.stopping&&!failed){
        const unresolved=this.data.notifications.some(n=>['attempted','uncertain','sent'].includes(n.status));
        this.data.mode=unresolved?'stop_incomplete':'stopped';
        if(unresolved)this.data.error??='unresolved_send_manual_check_required';
      }this.save();}
    }
  }
}
