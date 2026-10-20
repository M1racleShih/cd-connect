/** Durable task ledger with explicit recovery; startup never replays native actions. */
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TASK_TOOLS } from './protocol.js';
import { TaskStore, canonical, sha256 } from './storage.js';
import { overlaps, workspaceWitness } from './workspace.js';

const EVENT_CAP = 256;
const EVIDENCE_CAP = 512;
const REVIEW_STATES = new Set(['awaiting_review', 'changes_requested', 'accepted', 'failed', 'needs_human', 'needs_recovery', 'waiting_approval', 'cancelled']);
const copy = value => structuredClone(value);
function fail(code) { throw new Error(code); }

function prompt(task, instruction) {
  return `cd-connect task ${task.id}, revision ${task.revision}, run ${task.run.id}.\n` +
    `The following JSON is the authorized task specification:\n${JSON.stringify(task.spec, null, 2)}\n` +
    (instruction ? `Continuation instruction: ${instruction}\n` : '') +
    'Use your existing model and native tool permissions. Do not delegate to subagents unless the human explicitly authorized them. Stay in the stated scope. If requirements or authorization are missing, stop and describe the exact question for the human. Finish with your understanding, changed files and their digests or versions, verification commands, exit status and relevant results, and any unresolved questions. Do not claim reviewer acceptance. The reviewer will inspect native evidence after this turn ends.';
}

/** Project task evidence only; raw model configuration and streams never enter the ledger. */
function evidenceData(event) {
  const { type, data } = event;
  if (type === 'assistant/message') return { content: data.message.content, interrupted: !!data.interrupted };
  if (type === 'tool/call') return { call_id: data.callId, name: data.name, arguments: data.arguments };
  if (type === 'tool/result') return { call_id: data.message.toolCallId, content: data.message.content, is_error: !!data.message.isError };
  if (type === 'approval/asked') return { id: data.id, tool_name: data.toolName, call_id: data.callId ?? null, reason: data.reason ?? null };
  if (type === 'approval/decided') return { id: data.id, outcome: data.outcome };
  if (type === 'turn/end') return { turn: data.turn, reason: { kind: data.reason.kind } };
}

export class TaskManager {
  constructor(native, identity, { stateDir, store = new TaskStore(stateDir, identity.instance_id) } = {}) {
    this.native = native;
    this.identity = identity;
    this.store = store;
    this.tasks = new Map(store.data.tasks.map(t => [t.id, t]));
    for (const task of this.tasks.values()) if (task.run) task.run = task.runs.at(-1);
    this.requests = new Map(store.data.requests.map(r => [r.id, r]));
    this.sessions = new Map([...this.tasks.values()].filter(t => t.session_id).map(t => [t.session_id, t]));
    this.waiters = new Map();
    this.observedCursors = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
    this.unsubscribe = native.subscribe(event => {
      if (this.closed || this.storageError || !this.sessions.has(event.session_id)) return;
      if (this.needsRecovery(this.sessions.get(event.session_id))) {
        if (event.kind === 'event') this.observedCursors.set(event.session_id, Math.max(this.observedCursors.get(event.session_id) ?? -1, event.event.seq));
        return;
      }
      try { this.observe(event); this.persist(); }
      catch { this.storageError = 'storage_or_observation_failed_reload_and_reconcile'; this.wakeAll(); }
    });
  }

  persist() {
    try {
      this.store.save({ version: 1, instance_id: this.identity.instance_id, tasks: [...this.tasks.values()], requests: [...this.requests.values()] });
    } catch (error) { this.storageError = error.message; this.wakeAll(); throw error; }
  }

  exclusive(operation) {
    const result = this.queue.then(() => { this.check(); return operation(); });
    this.queue = result.catch(() => {});
    return result;
  }

  check() {
    if (this.closed) fail('bridge_closed');
    if (this.storageError) fail(this.storageError);
  }

  async call(name, input, signal) {
    const args = TASK_TOOLS[name].schema.parse(input);
    if (['task_get', 'task_wait', 'task_evidence'].includes(name)) {
      this.check();
      const task = this.find(args.task_id);
      this.checkWorkspace(task);
      if (name === 'task_wait') return this.wait(task, args, signal);
      return name === 'task_get' ? this.snapshot(task) : this.evidence(task, args);
    }
    return this.exclusive(async () => {
      if (name === 'task_submit') return this.once(args.request_id, { name, args }, () => this.submit(args));
      const task = this.find(args.task_id);
      return this.once(args.request_id, { name, args }, async () => {
        if (task.revision !== args.expected_revision) fail('revision_conflict');
        if (name === 'task_recover') { task.revision++; this.persist(); return this.recover(task, args); }
        if (this.needsRecovery(task)) fail('recovery_required_read_snapshot_and_native_logs');
        this.checkWorkspace(task);
        if (name === 'task_continue' && !args.run_id) fail('run_id_required');
        if (['task_continue', 'task_cancel'].includes(name) && task.run?.id !== args.run_id) fail('run_conflict');
        if (name === 'task_cancel') return this.cancel(task, args);
        if (name === 'task_continue') return this.continue(task, args);
        return this.review(task, args);
      });
    });
  }

  find(id) { const task = this.tasks.get(id); if (!task) fail('unknown_task'); return task; }
  needsRecovery(task) { return task.reconciled_runtime !== this.identity.runtime_id; }

  async once(id, request, operation) {
    const hash = sha256(canonical(request));
    const previous = this.requests.get(id);
    if (previous) {
      if (previous.hash !== hash) fail('request_id_content_conflict');
      if (previous.error) fail(previous.error);
      if (previous.result) return copy(previous.result);
      if (previous.task_id) return { ...this.snapshot(this.find(previous.task_id)), request_status: 'pending_reconcile' };
      if (request.name !== 'task_submit') fail('request_pending_manual_check_required');
      // No task/intent exists in this atomic snapshot, so this submission cannot have called native code.
    }
    if (!previous && this.requests.size >= 2000) fail('request_capacity_archive_required');
    const record = previous ?? { id, hash, request, status: 'pending', at: new Date().toISOString(),
      ...(request.args.task_id ? { task_id: request.args.task_id } : {}) };
    this.requests.set(id, record);
    this.persist();
    this.currentRequest = record;
    try {
      const result = await operation();
      record.result = copy(result); record.status = 'completed';
      this.persist();
      return result;
    } catch (error) {
      if (!this.storageError) {
        record.error = /^[a-z0-9_]+$/.test(error.message) ? error.message : 'task_operation_failed_check_DSH';
        record.status = 'failed'; this.persist();
      }
      throw error;
    } finally { this.currentRequest = null; }
  }

  claimWorkspace(task) {
    if ([...this.tasks.values()].some(t => t !== task && overlaps(t.spec.workspace, task.spec.workspace) &&
      t.workspace_claimed)) fail('workspace_has_unaccepted_task');
  }

  async submit(args) {
    if (this.tasks.size >= 100) fail('task_capacity_archive_required');
    if (!isAbsolute(args.workspace)) fail('workspace_must_be_absolute');
    const workspace = await realpath(args.workspace);
    if (!(await stat(workspace)).isDirectory()) fail('workspace_must_be_existing_directory');
    const { request_id, ...spec } = args;
    const task = { id: `task-${randomUUID()}`, revision: 1, spec: { ...spec, workspace }, state: 'dispatching', session_id: null,
      origin_instance: this.identity.instance_id, reconciled_runtime: this.identity.runtime_id,
      workspace_claimed: true,
      events: [], event_seq: 0, evidence: [], evidence_seq: 0, reviews: [], runs: [], native_cursor: -1,
      creation: { requested_session_id: randomUUID(), stage: 'prepared' } };
    this.claimWorkspace(task);
    task.workspace_before = workspaceWitness(workspace);
    this.tasks.set(task.id, task);
    this.currentRequest.task_id = task.id;
    this.addEvent(task, 'submitted'); this.persist();
    await this.create(task);
    if (task.session_id) await this.dispatch(task);
    return this.snapshot(task);
  }

  async create(task) {
    this.check();
    task.creation.stage = 'attempted'; this.persist();
    let receipt;
    try { receipt = await this.native.create(task.spec.workspace, task.creation.requested_session_id); }
    catch { this.setState(task, 'needs_human', 'native_create_outcome_unknown_no_replay'); this.persist(); return; }
    task.creation.receipt = receipt; task.creation.stage = 'recorded';
    task.session_id = receipt.sessionId;
    this.sessions.set(task.session_id, task); this.persist();
  }

  async dispatch(task, instruction) {
    this.check();
    if (task.runs.length >= 20) fail('run_capacity_archive_required');
    const id = `run-${randomUUID()}`;
    task.run = { id, request_id: `cd-connect:${id}`, stage: 'prepared', instruction: instruction ?? null,
      control: instruction === undefined ? null : { cwd: task.spec.workspace, cursor: task.native_cursor },
      approvals: [],
      evidence_start: task.evidence_seq, execution_completed: false, matched: false, turn: null,
      native_start: task.native_cursor, native_hashes: {} };
    task.run.text = prompt(task, instruction);
    task.run.text_sha256 = sha256(task.run.text);
    task.runs.push(task.run);
    this.setState(task, 'dispatching'); this.persist();
    await this.sendPrepared(task);
  }

  async sendPrepared(task) {
    this.check();
    if (task.run.stage === 'prepared') this.setState(task, 'dispatching');
    task.run.stage = 'attempted'; this.persist();
    let receipt;
    try { receipt = await (task.run.control ? this.native.continue(task.session_id, task.run.request_id, task.run.text, task.run.control) :
      this.native.prompt(task.session_id, task.run.request_id, task.run.text)); }
    catch (error) { this.setState(task, 'needs_human', ['native_run_changed_control_rejected', 'native_session_unavailable_control_rejected'].includes(error.message) ? error.message : 'native_prompt_outcome_unknown_no_replay'); this.persist(); return; }
    task.run.receipt = receipt; task.run.stage = 'recorded';
    if (receipt.accepted !== true) this.setState(task, 'needs_human', 'native_prompt_not_accepted_check_DSH');
    else if (task.state === 'dispatching') this.setState(task, 'running');
    this.addEvent(task, 'native_accepted'); this.persist();
  }

  async continue(task, args) {
    if (!['changes_requested', 'accepted', 'cancelled', 'failed'].includes(task.state)) fail('review_required_before_continue');
    this.claimWorkspace(task);
    if (!await this.nativeIdle(task)) fail('native_session_not_idle_or_workspace_changed');
    if (!['changes_requested', 'accepted', 'cancelled', 'failed'].includes(task.state)) fail('native_state_changed_during_check');
    if (task.runs.length >= 20) fail('run_capacity_archive_required');
    task.revision++;
    task.workspace_before = workspaceWitness(task.spec.workspace);
    task.workspace_claimed = true;
    task.artifacts = null;
    this.currentRequest.task_id = task.id;
    await this.dispatch(task, args.instruction);
    return this.snapshot(task);
  }

  cancel(task, args) {
    if (!['running', 'waiting_approval'].includes(task.state) || !task.run.matched || task.run.execution_completed) fail('cancel_requires_matched_active_run');
    if (task.run.cancellation) fail('cancel_already_requested_check_DSH');
    task.revision++;
    const cancellation = task.run.cancellation = { request_id: args.request_id, status: 'attempted', at: new Date().toISOString() };
    this.addEvent(task, 'cancel_requested', { run_id: task.run.id }); this.persist();
    try {
      // Native adapter has no await between exact live-log/queue checks and cancel.
      const receipt = this.native.cancel(task.session_id, { cwd: task.spec.workspace, cursor: task.native_cursor,
        turn: task.run.turn, request_id: task.run.request_id });
      if (receipt.accepted !== true) throw new Error('cancel_not_accepted');
      cancellation.accepted = true; cancellation.receipt = receipt;
      if (cancellation.status === 'attempted') cancellation.status = 'accepted';
      if (!task.run.execution_completed && !['needs_human', 'failed'].includes(task.state)) this.setState(task, 'cancel_requested');
    } catch (error) {
      cancellation.status = error.message === 'native_run_changed_control_rejected' ? 'rejected' : 'outcome_unknown';
      this.setState(task, 'needs_human', cancellation.status === 'rejected' ? error.message : 'native_cancel_outcome_unknown_no_replay');
    }
    this.persist(); return this.snapshot(task);
  }

  async nativeIdle(task) {
    const status = this.native.status(task.session_id);
    if (status.status !== 'unavailable') return status.status === 'idle' && status.cwd === task.spec.workspace;
    const log = await this.native.read(task.session_id);
    return log.source === 'prepared' && log.cwd === task.spec.workspace && task.run.execution_completed &&
      log.cursor === task.native_cursor && Object.entries(task.run.native_hashes).every(([seq, hash]) =>
        log.events[seq] && sha256(canonical(log.events[seq])) === hash);
  }

  async review(task, args) {
    const reviewable = () => task.state === 'awaiting_review' ||
      (args.decision === 'changes_requested' && task.state === 'needs_human' && task.reason === 'accepted_artifacts_changed');
    if (!reviewable() || task.run.id !== args.run_id) fail('current_run_not_awaiting_review');
    if (!await this.nativeIdle(task)) fail('native_session_not_idle');
    this.checkWorkspace(task);
    if (!reviewable()) fail('native_state_changed_during_check');
    if (args.decision === 'accepted' && task.artifacts?.valid !== true) fail('artifact_evidence_invalid_rework_required');
    const evidence = task.evidence.filter(e => e.run_id === args.run_id);
    if (!args.evidence_ids.every(id => evidence.some(e => e.id === id))) fail('invalid_or_expired_evidence_reference');
    task.reviews.push({ ...args, reviewed_revision: task.revision, artifact_sha256: task.artifacts?.witness?.sha256 ?? null, at: new Date().toISOString() });
    task.revision++;
    if (args.decision === 'accepted') task.workspace_claimed = false;
    this.setState(task, args.decision);
    this.currentRequest.task_id = task.id;
    this.persist();
    return this.snapshot(task);
  }

  /** Read logs first; only a provably unattempted intent may be dispatched explicitly. */
  async recover(task, args) {
    let log;
    try { log = await this.native.read(task.session_id ?? task.creation.requested_session_id); }
    catch {
      // A prepared creation has never crossed the native-call fence.
      if (!task.session_id && task.creation.stage === 'prepared' && args.action === 'dispatch_prepared') {
        if (workspaceWitness(task.spec.workspace).sha256 !== task.workspace_before.sha256) fail('workspace_changed_before_dispatch');
        this.claimWorkspace(task); task.reconciled_runtime = this.identity.runtime_id;
        await this.create(task); if (task.session_id) await this.dispatch(task);
        this.currentRequest.task_id = task.id;
        return this.snapshot(task);
      }
      this.setState(task, 'needs_human', 'native_log_unavailable_no_replay'); this.persist(); return this.snapshot(task);
    }
    if (log.cwd !== task.spec.workspace) {
      this.setState(task, 'needs_human', 'native_workspace_mismatch_no_replay'); this.persist(); return this.snapshot(task);
    }
    if (log.cursor < (this.observedCursors.get(task.session_id) ?? -1)) {
      task.reconciled_runtime = null;
      this.setState(task, 'needs_human', 'native_advanced_during_recovery_inspect_again');
      this.persist(); return this.snapshot(task);
    }
    task.reconciled_runtime = this.identity.runtime_id;
    const recovery = { at: new Date().toISOString(), source: log.source, cursor: log.cursor, action: args.action };
    task.recovery = recovery;
    if (!task.session_id) {
      // create can return a different identity; a requested-id log does not prove the actual receipt.
      this.setState(task, 'needs_human', 'create_receipt_missing_manual_mapping_required');
    } else if (!task.run) {
      if (args.action === 'dispatch_prepared' && workspaceWitness(task.spec.workspace).sha256 === task.workspace_before.sha256) {
        this.claimWorkspace(task); await this.dispatch(task);
      } else this.setState(task, 'needs_human', 'known_session_no_prompt_use_dispatch_prepared');
    } else {
      const run = task.run;
      if (!Array.isArray(log.events) || log.cursor < task.native_cursor || log.events.length !== log.cursor + 1 ||
          log.events.some((e, i) => e.seq !== i) ||
          Object.entries(run.native_hashes).some(([seq, hash]) => !log.events[seq] || sha256(canonical(log.events[seq])) !== hash)) {
        this.setState(task, 'needs_human', 'native_log_conflict_or_cursor_invalid_no_replay');
      } else {
        // Clear only transport uncertainty that the native request identity can now resolve.
        if (['native_prompt_outcome_unknown_no_replay', 'native_event_gap_reconcile_required', 'native_advanced_during_recovery_inspect_again'].includes(task.reason)) this.setState(task, 'dispatching');
        // An uncertain cancel is never resent. A matching durable terminal
        // event can resolve its outcome; later foreign activity still fences it.
        if (task.reason === 'native_cancel_outcome_unknown_no_replay' && run.matched &&
            log.events.some(e => e.type === 'turn/end' && e.data.turn === run.turn && ['completed', 'aborted'].includes(e.data.reason.kind))) {
          this.setState(task, run.execution_completed ? 'execution_completed' : 'dispatching');
          if (run.execution_completed && run.cancellation) run.cancellation.status = run.end_reason.kind === 'aborted' ? 'confirming' : 'not_cancelled';
        }
        for (const event of log.events) if (event.seq > task.native_cursor) this.observe({ kind: 'event', session_id: task.session_id, event }, true);
        const queued = log.queued_request_ids?.includes(run.request_id);
        if (run.matched || queued) {
          run.reconciled_acceptance = { request_id: run.request_id, queued: !!queued, cursor: log.cursor };
          if (!run.execution_completed && !['needs_human', 'failed'].includes(task.state)) this.setState(task, run.cancellation?.accepted ? 'cancel_requested' : run.approvals?.some(a => !a.outcome) ? 'waiting_approval' : 'running');
          if (run.execution_completed && this.native.status(task.session_id).status !== 'running') this.settle(task, true);
          if (run.execution_completed && !task.artifacts) task.artifacts = { valid: false, reason: 'completion_witness_missing_after_interruption' };
          if (!run.execution_completed && log.source !== 'live' && !queued) this.setState(task, 'needs_human', 'native_run_interrupted_inspect_before_new_work');
        } else if (run.stage === 'prepared' && args.action === 'dispatch_prepared') {
          if (workspaceWitness(task.spec.workspace).sha256 !== task.workspace_before.sha256) fail('workspace_changed_before_dispatch');
          this.claimWorkspace(task); await this.sendPrepared(task);
        } else this.setState(task, 'needs_human', run.stage === 'prepared' ? 'prompt_prepared_use_dispatch_prepared' : 'native_acceptance_unknown_no_replay');
      }
    }
    this.checkWorkspace(task);
    this.observedCursors.delete(task.session_id);
    const { cursor: native_cursor, ...details } = recovery;
    this.addEvent(task, 'reconciled', { ...details, native_cursor });
    this.currentRequest.task_id = task.id; this.persist();
    return this.snapshot(task);
  }

  observe(item, replay = false) {
    const task = this.sessions.get(item.session_id);
    if (!task?.run || this.closed || (!replay && this.needsRecovery(task))) return;
    const run = task.run;
    if (item.kind === 'event') {
      const event = item.event;
      const hash = sha256(canonical(event));
      if (event.seq <= task.native_cursor) {
        if (run.native_hashes[event.seq] && run.native_hashes[event.seq] !== hash) this.setState(task, 'needs_human', 'native_event_content_conflict');
        return;
      }
      if (task.native_cursor >= 0 && event.seq !== task.native_cursor + 1) {
        task.reconciled_runtime = null;
        this.setState(task, 'needs_human', 'native_event_gap_reconcile_required'); return;
      }
      if (Object.keys(run.native_hashes).length >= 50000) {
        task.reconciled_runtime = null;
        this.setState(task, 'needs_human', 'native_event_capacity_manual_check_required'); return;
      }
      task.native_cursor = event.seq;
      run.native_hashes[event.seq] = hash;
      if (event.type === 'turn/start') {
        task.native_turn = event.data.turn;
        if (run.execution_completed || REVIEW_STATES.has(task.state)) this.setState(task, 'needs_human', 'unexpected_native_turn_check_DSH');
      }
      if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        if (event.data.source.rpcId === run.request_id && !run.matched) {
          run.matched = true; run.turn = task.native_turn;
          if (!['needs_human', 'failed'].includes(task.state)) this.setState(task, 'running');
        } else this.setState(task, 'needs_human', 'unexpected_native_input_check_DSH');
      }
      if (event.type === 'turn/end' && !run.matched && event.data.turn === task.native_turn) {
        run.unmatched_end_reason = { kind: event.data.reason.kind };
        this.setState(task, 'needs_human', 'native_turn_ended_before_request_matched_check_DSH');
      }
      const approval = event.type === 'approval/asked' || event.type === 'approval/decided';
      // Approval audit events have no turn field; associate only while this matched turn is open.
      if (!run.matched || (approval ? run.execution_completed || task.native_turn !== run.turn : event.data.turn !== run.turn)) return;
      if (approval) {
        run.approvals ??= [];
        if (event.type === 'approval/asked') {
          if (run.approvals.length >= 50) { this.setState(task, 'needs_human', 'approval_capacity_check_DSH'); return; }
          run.approvals.push({ id: event.data.id, tool_name: event.data.toolName, call_id: event.data.callId ?? null,
            reason: event.data.reason?.slice(0, 4000) ?? null, native_seq: event.seq, outcome: null });
        } else {
          const asked = run.approvals.find(a => a.id === event.data.id && !a.outcome);
          if (!asked) this.setState(task, 'needs_human', 'approval_audit_mismatch_check_DSH');
          else {
            asked.outcome = event.data.outcome;
            if (['rejected', 'unavailable'].includes(asked.outcome)) run.permission_denied = true;
          }
        }
        if (!['needs_human', 'failed', 'cancel_requested'].includes(task.state)) this.setState(task,
          run.approvals.some(a => !a.outcome) ? 'waiting_approval' : 'running');
      }
      const data = evidenceData(event);
      if (data) {
        const json = JSON.stringify(data);
        const seq = ++task.evidence_seq;
        task.evidence.push({ id: `evidence-${seq}`, cursor: seq, run_id: run.id, type: event.type,
          native_ref: { session_id: task.session_id, seq: event.seq }, sha256: sha256(json),
          truncated: json.length > 8000, ...(json.length > 8000 ? { preview: json.slice(0, 8000) } : { data }) });
        if (task.evidence.length > EVIDENCE_CAP) task.evidence.shift();
        this.addEvent(task, 'evidence_available', { evidence_id: `evidence-${seq}`, native_seq: event.seq });
      }
      if (event.type === 'turn/end') {
        run.execution_completed = true; run.end_reason = { kind: event.data.reason.kind };
        if (!['needs_human', 'failed'].includes(task.state)) {
          if (run.cancellation) run.cancellation.status = event.data.reason.kind === 'aborted' ? 'confirming' : 'not_cancelled';
          this.setState(task, ['completed', 'aborted'].includes(event.data.reason.kind) ? 'execution_completed' : 'failed', event.data.reason.kind);
        }
      }
    } else if (item.kind === 'status') {
      if (item.status === 'idle') this.settle(task, replay);
    } else if (item.kind === 'error') {
      if (!run.execution_completed && (item.turn === run.turn || (!run.matched && item.turn === task.native_turn))) {
        run.failure = { category: 'model_or_execution_error', native_turn: item.turn, request_matched: run.matched };
        this.setState(task, 'failed', 'native_error_check_DSH');
      }
    } else this.setState(task, 'needs_human', `native_${item.kind}_check_DSH`);
  }

  settle(task, replay) {
    if (task.state !== 'execution_completed') return;
    if (task.run.end_reason?.kind === 'aborted') {
      if (task.run.cancellation) task.run.cancellation.status = 'confirmed';
      this.setState(task, 'cancelled', 'aborted'); return;
    }
    if (task.run.permission_denied) { this.setState(task, 'failed', 'permission_denied'); return; }
    if (task.run.approvals?.some(a => !a.outcome)) { this.setState(task, 'needs_human', 'approval_outcome_missing_check_DSH'); return; }
    this.complete(task, replay);
  }

  complete(task, replay) {
    if (!task.artifacts) {
      try { task.artifacts = replay ? { valid: false, reason: 'completion_witness_missing_after_interruption' } :
        { valid: true, witness: workspaceWitness(task.spec.workspace), at: new Date().toISOString(), run_id: task.run.id }; }
      catch { task.artifacts = { valid: false, reason: 'workspace_witness_unavailable' }; }
    }
    this.setState(task, 'awaiting_review');
  }

  checkWorkspace(task) {
    if (!task.artifacts?.valid) return;
    let changed;
    try { changed = workspaceWitness(task.spec.workspace).sha256 !== task.artifacts.witness.sha256; }
    catch { changed = true; }
    if (changed) {
      task.artifacts.valid = false; task.artifacts.reason = 'workspace_changed_since_completion';
      for (const review of task.reviews) if (review.run_id === task.run.id) review.evidence_valid = false;
      if (task.state === 'accepted') this.setState(task, 'needs_human', 'accepted_artifacts_changed');
      this.addEvent(task, 'evidence_invalidated'); this.persist();
    }
  }

  setState(task, state, reason) {
    task.state = state; task.reason = reason ?? null;
    this.addEvent(task, 'state', { state, reason: task.reason });
  }

  addEvent(task, type, data = {}) {
    task.events.push({ ...data, cursor: ++task.event_seq, type, at: new Date().toISOString() });
    if (task.events.length > EVENT_CAP) task.events.shift();
    for (const wake of this.waiters.get(task.id) ?? []) wake();
  }

  snapshot(task) {
    const state = this.needsRecovery(task) || this.closed ? 'needs_recovery' : task.state;
    const run = task.run ? { ...task.run } : null;
    if (run) { delete run.text; delete run.native_hashes; }
    return copy({ task_id: task.id, revision: task.revision, spec: task.spec, state, reason: task.reason ?? null,
      instance_id: this.identity.instance_id, runtime_id: this.identity.runtime_id, session_id: task.session_id,
      creation: task.creation, run, status_detail: {
        category: state === 'waiting_approval' ? 'human_approval_required' : state === 'cancel_requested' ? 'cancellation_pending' :
          state === 'cancelled' ? 'cancelled' : state === 'failed' ? (task.run?.permission_denied ? 'permission_denied' :
            task.run?.end_reason?.kind === 'error' || task.run?.failure ? 'model_or_execution_error' : 'execution_failed') : state,
        native_end_reason: task.run?.end_reason?.kind ?? task.run?.unmatched_end_reason?.kind ?? null,
        pending_approvals: task.run?.approvals?.filter(a => !a.outcome) ?? [],
        permission_denied: !!task.run?.permission_denied,
      }, native: task.session_id ? this.native.status(task.session_id) : null,
      recovery: task.recovery ?? null, artifacts: task.artifacts ?? null,
      workspace_claimed: task.workspace_claimed,
      event_cursor: task.event_seq, evidence_cursor: task.evidence_seq, reviews: task.reviews,
      storage: 'durable_snapshot_v1', next_action: state === 'needs_recovery' ? 'task_recover_inspect_native_logs' :
        state === 'awaiting_review' ? (task.artifacts?.valid ? 'read_evidence_then_review' : 'evidence_invalid_request_rework') :
        state === 'waiting_approval' ? 'human_decide_in_DSH' : state === 'cancelled' ? 'inspect_effects_before_explicit_continue' :
        state === 'changes_requested' ? 'continue_with_corrections' : state === 'accepted' ? 'done_or_authorized_next_stage' :
          ['failed', 'needs_human'].includes(state) ? 'ask_human_check_DSH' : 'wait' });
  }

  page(items, cursor, limit, last) {
    if (cursor > last) fail('cursor_ahead_of_stream');
    if (items.length && cursor < items[0].cursor - 1) fail('cursor_expired_inspect_DSH');
    const selected = items.filter(e => e.cursor > cursor).slice(0, limit);
    return copy({ items: selected, next_cursor: selected.at(-1)?.cursor ?? cursor, has_more: items.some(e => e.cursor > (selected.at(-1)?.cursor ?? cursor)) });
  }

  evidence(task, args) {
    if (args.run_id !== task.run?.id) fail('only_current_run_evidence_available');
    const cursor = args.cursor === 0 ? task.run.evidence_start : args.cursor;
    if (cursor < task.run.evidence_start) fail('cursor_before_current_run');
    const page = this.page(task.evidence.filter(e => e.run_id === args.run_id), cursor, args.limit, task.evidence_seq);
    return { ...page, run_id: args.run_id, artifacts: copy(task.artifacts ?? null) };
  }

  async wait(task, args, signal) {
    const read = timed_out => {
      if (this.storageError) fail(this.storageError);
      this.checkWorkspace(task);
      return { task: this.snapshot(task), ...this.page(task.events, args.cursor, args.limit, task.event_seq), timed_out };
    };
    const initial = read(false);
    if (initial.items.length || REVIEW_STATES.has(initial.task.state) || args.timeout_ms === 0) return initial;
    if (signal?.aborted) fail('wait_cancelled');
    let timedOut = false;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.waiters.get(task.id)?.delete(wake); signal?.removeEventListener('abort', abort); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new Error('wait_cancelled')); };
      const timer = setTimeout(() => { timedOut = true; wake(); }, args.timeout_ms);
      if (!this.waiters.has(task.id)) this.waiters.set(task.id, new Set());
      this.waiters.get(task.id).add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
    return read(timedOut);
  }

  wakeAll() { for (const set of this.waiters.values()) for (const wake of set) wake(); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe(); this.wakeAll();
    await this.queue;
    this.store.close();
  }
}
