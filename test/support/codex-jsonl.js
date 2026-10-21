/** Isolated app-server protocol peer; never invokes Codex or a model. */
import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin});
for await(const line of lines){
 const m=JSON.parse(line);
 if(m.id===undefined)continue;
 if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{platformFamily:'unix',platformOs:'linux'}}));
 else if(m.method==='thread/name/set')console.log(JSON.stringify({id:m.id,result:{}}));
 else if(m.method==='thread/turns/list')console.log(JSON.stringify({id:m.id,result:{data:[],nextCursor:null}}));
 else if(m.method==='thread/resume')console.log(JSON.stringify({id:m.id,error:{code:-32600,message:'private provider body active writer'}}));
 else if(m.method==='thread/start'){
  if(process.argv[2]==='drop')continue;
  console.log(JSON.stringify({id:m.id,result:{thread:{id:'fixture-thread',status:{type:'idle'}},model:'inherited-fixture',cwd:'/tmp',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly'}}}));
 }else if(m.method==='thread/read')console.log(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId,status:{type:'active'}}}}));
 else if(m.method==='turn/start'){
  console.log(JSON.stringify({id:m.id,result:{turn:{id:'fixture-turn',status:'inProgress',items:[]}}}));
  console.log(JSON.stringify({id:999,method:'item/permissions/requestApproval',params:{}}));
 }else console.log(JSON.stringify({id:m.id,error:{code:-32601,message:'unsupported'}}));
}
