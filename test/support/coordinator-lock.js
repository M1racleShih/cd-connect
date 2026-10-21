import { Journal } from '../../src/coordinator/store.js';
try {
  const j=new Journal(process.argv[2]);
  process.send({owned:true});
  process.on('message',()=>{j.close();process.exit(0);});
}catch{process.send({owned:false});process.exitCode=1;process.disconnect();}
