/** Process-exit harness. Only disposable paths supplied by recovery.test.js are used. */
import { TaskManager } from '../src/tasks.js';
import { TaskStore } from '../src/storage.js';
import { simulatedNative, taskSpec } from '../test/support/native.js';
const [dir, workspace, crash] = process.argv.slice(2);
const exit = () => process.exit(73);
const native = simulatedNative(dir, workspace, {
  differentSession: crash === 'create-receipt-lost',
  afterCreate: crash === 'create-receipt-lost' ? exit : undefined,
  afterPrompt: crash === 'prompt-receipt-lost' ? exit : undefined,
});
const store = new TaskStore(`${dir}/ledger`, 'crash-instance');
const save = store.save.bind(store);
store.save = data => {
  const task = data.tasks[0];
  const stage = task?.run?.stage;
  const hit = (crash === 'request-only' && data.requests.length && !task) ||
    (crash === 'create-prepared' && task?.creation.stage === 'prepared') ||
    (crash === 'create-attempted' && task?.creation.stage === 'attempted' && !task.session_id) ||
    (crash === 'create-recorded' && task?.creation.stage === 'recorded' && !task.run) ||
    (crash === 'prompt-prepared' && stage === 'prepared') ||
    (crash === 'prompt-attempted' && stage === 'attempted') ||
    (crash === 'prompt-receipt-uncommitted' && stage === 'recorded') ||
    (crash === 'prompt-recorded' && stage === 'recorded');
  if (hit && crash === 'prompt-receipt-uncommitted') exit();
  save(data);
  if (hit) exit();
};
const manager = new TaskManager(native, { instance_id: 'crash-instance', runtime_id: 'crashed-runtime' }, { store });
await manager.call('task_submit', taskSpec(workspace));
if (crash === 'completed') { native.begin(); native.finish(); exit(); }
throw new Error('crash_checkpoint_not_reached');
