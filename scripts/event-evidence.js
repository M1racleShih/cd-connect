/** Bound, read-only evidence access. No arbitrary tool forwarding. */
import { Journal } from '../src/coordinator/store.js';
import { BridgeReader } from '../src/coordinator/bridge.js';
import { readReviewBundle } from '../src/coordinator/review.js';
import { safeCode } from '../src/coordinator/schema.js';
let reader;
try {
  if(process.argv.length!==3)throw new Error('usage_event_evidence_state_directory');
  const state=Journal.read(process.argv[2]);
  reader=new BridgeReader(state.config.bridge_dir);
  console.log(JSON.stringify(await readReviewBundle(reader,state.config.binding),null,2));
}catch(e){console.error(safeCode(e));process.exitCode=1;}
finally{await reader?.close();}
