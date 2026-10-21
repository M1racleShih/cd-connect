// Independent review fixture: JSONL only, never starts a real model.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const turns=[];
if(process.env.REVIEW_LOG){
  appendFileSync(process.env.REVIEW_LOG,JSON.stringify({pid:process.pid})+'\n');
  process.on('exit',()=>appendFileSync(process.env.REVIEW_LOG,JSON.stringify({event:'exit'})+'\n'));
}
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line); if(m.id===undefined)continue;
  if(process.env.REVIEW_LOG)appendFileSync(process.env.REVIEW_LOG,JSON.stringify({method:m.method})+'\n');
  const send=result=>process.stdout.write(JSON.stringify({id:m.id,result})+'\n');
  if(m.method==='utf8') {
    const bytes=Buffer.from(JSON.stringify({id:m.id,result:{text:'建议通过'}})+'\n');
    const split=bytes.indexOf(Buffer.from('建'))+1;
    process.stdout.write(bytes.subarray(0,split));
    await new Promise(r=>setTimeout(r,30));
    process.stdout.write(bytes.subarray(split));
  } else if(m.method==='utf8-lines') {
    const bytes=Buffer.from(JSON.stringify({method:'notice',params:{text:'中文🙂'}})+'\n'+JSON.stringify({id:m.id,result:{text:'建议通过🙂\n下一行'}})+'\n');
    // Every byte boundary, including 3/4-byte code points and JSONL separators.
    for(const byte of bytes){process.stdout.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,1));}
  } else if(m.method==='truncated') {
    const bytes=Buffer.from('{"text":"中');process.stdout.write(bytes.subarray(0,bytes.length-1));process.stdout.end();
  } else if(m.method==='oversized')process.stdout.write('x'.repeat(8*1024*1024+1));
  else if(m.method==='initialize')send({});
  else if(m.method==='thread/read')send({thread:{id:m.params.threadId,status:{type:'idle'}}});
  else if(m.method==='thread/turns/list'){
    if(turns.length && process.env.REVIEW_HISTORY_FAILURE){
      writeFileSync(process.env.REVIEW_WAITING,'ready');
      while(!existsSync(process.env.REVIEW_RELEASE))await new Promise(r=>setTimeout(r,10));
      if(process.env.REVIEW_HISTORY_FAILURE==='disconnect')process.exit(0);
      // A real request timeout; no fabricated response or model invocation.
    }else send({data:turns,nextCursor:null});
  }
  else if(m.method==='thread/resume') {
    if(process.env.REVIEW_REJECT==='1')process.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:'already has an active writer'}})+'\n');
    else send({thread:{id:m.params.threadId,status:{type:'idle'}},model:'fixture',cwd:'/tmp',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly'}});
  } else if(m.method==='turn/start') {
    const turn={id:'current-turn',status:process.env.REVIEW_HISTORY_FAILURE?'inProgress':'completed',items:[{type:'userMessage',content:m.params.input},{type:'agentMessage',text:'review fixture completed'}]};
    turns.push(turn);send({turn:{...turn,status:'inProgress'}});
  } else process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'fixture unsupported'}})+'\n');
}
