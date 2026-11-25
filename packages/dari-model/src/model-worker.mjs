import {parentPort,workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {encodeLocatedInput} from './located-input.mjs';
import {TeloraWasm} from './telora-wasm.mjs';
const state=new Int32Array(workerData.buffer,0,2),bytes=new Uint8Array(workerData.buffer,8);
let runtime,startupError;
try{runtime=new TeloraWasm(readFileSync(workerData.artifact));}catch(error){startupError=error;}
function finish(response){
 let data=new TextEncoder().encode(JSON.stringify(response));
 if(data.length>bytes.length)data=new TextEncoder().encode(JSON.stringify({error:'Model ABI response exceeds shared buffer'}));
 bytes.set(data);Atomics.store(state,1,data.length);Atomics.store(state,0,1);Atomics.notify(state,0);
}
parentPort.on('message',message=>{
 if(message.close){parentPort.close();return;}
 try{
  if(startupError)throw startupError;
  // 单服务模型：method 就是 ABI 方法；服务集合模型：method 是路由，ABI 方法嵌在 input 里。
  const packet=message.route
   ?{method:message.route,input:{method:message.method,input:message.input}}
   :{method:message.method,input:message.input};
  const origins=(message.origins??[]).map(o=>({...o,path:message.route?['input','input',...o.path]:['input',...o.path]}));
  const response=runtime.request(encodeLocatedInput(packet,origins));
  finish(response.error?{error:response.diagnostics??response}:{value:response.ok});
 }catch(error){finish({error:error.diagnostics??error.message});}
});
