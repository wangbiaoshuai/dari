import {readDariSource} from './source-file.ts';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {PluginConfig} from './config.ts';
import type {Knowledge} from './knowledge.ts';
import type {AttachmentsService,ToolDefinition,ToolExec} from './host.ts';
import type {TimeContext} from './time-context.ts';

// The model proof and runtime service execute outside the agent process.
export function createDariTools(options:{config:PluginConfig['dari'];knowledge:Knowledge;timeContext:TimeContext;attachments?:()=>AttachmentsService|undefined}){
 const workers=new Map<string,{child:ChildProcessWithoutNullStreams;request:(value:unknown)=>Promise<any>}>();
 const contexts=new Map<string,{now:string;epochMillis:number;timeZone:string|null}>();
 let closed=false;
 function worker(database:string,model:string){
  const workerKey=JSON.stringify([database,model,options.config]);
  let w=workers.get(workerKey);if(w)return w;
  if(closed)throw Error('DARI tools disposed');
  const c=options.config??{};
  // 默认把宿主插件自身作为 service 入口：同一个 bundle 用 DARI_SERVICE 区分角色。
  const self=fileURLToPath(new URL('./index.mjs',import.meta.url));
  const service=c.service??self;
  const args=c.service
   ?[service,'--integration',c.integration??self,'--options',JSON.stringify({model}),'--database',database]
   :[service,'--options',JSON.stringify({model}),'--database',database];
  const env=c.service?process.env:{...process.env,DARI_SERVICE:'1'};
  const child=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe'],detached:true,env});
  let stderr='',sequence=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}};
  const fail=(error:Error)=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();workers.delete(workerKey);};
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-6000);});
  child.stdin.on('error',fail);child.on('error',fail);child.on('exit',code=>fail(Error('DARI service exited '+code+': '+stderr)));
  createInterface({input:child.stdout}).on('line',line=>{try{const v=JSON.parse(line),p=pending.get(v.id);if(!p)return;pending.delete(v.id);clearTimeout(p.timer);if(v.error)p.reject(Error(v.error));else p.resolve(v.result);}catch(e){fail(e instanceof Error?e:Error(String(e)));stop();}});
  w={child,request:(value:any)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{fail(Error('DARI request timed out'));stop();},65000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({...value,id})+'\n');})};
  workers.set(workerKey,w);return w;
 }
 const output={schema:{type:'object',additionalProperties:true},render:(_args:unknown,value:any)=>[{type:'text',text:value.text}]};
 const source=(root:string,raw:unknown)=>readDariSource(root,raw,'DARI').text;
 function environment(exec:ToolExec){
  exec.signal?.throwIfAborted();const entry=options.knowledge.ensureWorkspace(exec);
  if(!entry.settings.dataFile)throw Error('DARI requires the workspace dataFile');
  const session=exec.agent?.session;if(!session?.id)throw Error('DARI requires a session');
  const key=JSON.stringify([entry.root,session.id]);
  let context=contexts.get(key);
  if(!context){const epochMillis=Date.now(),zone=options.timeContext.zones.get(session);context={epochMillis,now:new Date(epochMillis).toISOString(),timeZone:zone?.kind==='resolved'?zone.timeZone:null};if(contexts.size>=128)contexts.delete(contexts.keys().next().value!);contexts.set(key,context);}
  return {entry,key,context,host:worker(entry.settings.dataFile,entry.settings.model)};
 }
 function renderProbe(value:any,purpose:string):string{
  const lines=['Succeed','-------',`purpose: ${purpose}`];
  for(const entry of value.bindings??[]){
   const columns=(entry.columns??[]).map((c:any)=>c.name) as string[],rows=(entry.rows??[]) as any[];
   lines.push('',`Probe ${entry.binding??'?'} · rows=${entry.rowCount??0} · returned=${rows.length}`);
   if(columns.length){lines.push('','| '+columns.join(' | ')+' |','| '+columns.map(()=>'---').join(' | ')+' |');for(const row of rows)lines.push('| '+columns.map(column=>{const v=row?.[column];return v===null||v===undefined?'':String(v);}).join(' | ')+' |');}
   if((entry.rowCount??0)>rows.length)lines.push('',`另有 ${(entry.rowCount??0)-rows.length} 行未返回`);
  }
  lines.push('','探测只用于确认取值，最终答案须在最终稿重新取数');
  return lines.join('\n');
 }
 const tools:ToolDefinition[]=[...(['check','resolve'] as const).map(method=>({
  name:'dari_'+(method==='resolve'?'submit':method),description:method==='check'?'Check the .dari file at the given path without reading business rows. Uses external model type proof for query_remote! and internal proof for query!/tree!. Accepts only src (a file path, not the source text). The file must already exist: create it with the file tool in an earlier step and never batch that write with this call.':'Check and execute the .dari file at the given path, publish its artifacts and deliver the unique Answer as a visible conversation message. Accepts only src (a file path, not the source text). Do not repeat the delivered Answer. The tool receipt includes displayed chart/table/value data for analysis. If delivery is unavailable, forward the returned Answer verbatim; add observations separately. The file must already exist: create it with the file tool in an earlier step and never batch that write with this call.',
  parameters:{type:'object',properties:{src:{type:'string',description:'工作区内的 .dari 文件路径（相对工作区或绝对路径），不是文件正文'}},required:['src'],additionalProperties:false},output,
  async execute(args:{src:string},exec:ToolExec){
   if(Object.keys(args).some(k=>k!=='src'))throw Error('Only src is accepted');
   const env=environment(exec);
   if(method==='resolve'&&env.entry.settings.requireRunApproval)throw Error('DARI execution is unavailable when requireRunApproval is enabled');
   const result=await env.host.request({method,source:source(env.entry.root,args.src),context:env.context,contextContractId:'dari-context/v2'});exec.signal?.throwIfAborted();
   if(method==='check')return {text:'Succeed\n-------\n'+result.types.map((t:any)=>'- '+t.name+': '+t.type).join('\n')+(result.warnings?'\n\n'+result.warnings:'')};
   if(typeof result.dataDocument!=='string'||typeof result.deliveryId!=='string')throw Error('DARI service must provide deliveryId and dataDocument');
   const links=new Map<string,string>(),fileUrls=new Map<string,string>(),artifacts=result.artifacts as Record<string,string>;
   const publish=async(name:string,content:string)=>{const attachments=options.attachments?.();if(!attachments)throw Error('Attachments service unavailable');const file=await attachments.saveFile({name,data:Buffer.from(content)});const path=attachments.fileHostPath(file);if(!path)throw Error('Attachment has no displayable path');fileUrls.set(name,pathToFileURL(path).href);links.set(name,encodeURI(path).replaceAll('(','%28').replaceAll(')','%29').replaceAll('#','%23').replaceAll('?','%3F'));};
   for(const [name,content]of Object.entries(artifacts))if(name.endsWith('.svg'))await publish(name,content);
   for(const [name,content]of Object.entries(artifacts))if(name.endsWith('.html')){let html=content;for(const [file,url]of links)html=html.replaceAll('src="'+file+'"','src="'+url.replaceAll('&','&amp;').replaceAll('"','&quot;')+'"');await publish(name,html);}
   let answer=result.answer as string;for(const [file,url]of links)answer=answer.replaceAll(']('+file+')',']('+url+')');
   const agent=exec.agent as {inject?:(message:unknown)=>void}|undefined;
   if(typeof agent?.inject!=='function')return {text:'Answer delivery unavailable; forward the following Markdown verbatim:\n\n'+answer};
   const deliveryId=result.deliveryId;
   await publish(deliveryId+'-data.md',result.dataDocument);
   await publish(deliveryId+'-answer.md',answer);
   const messageId=deliveryId;agent.inject({id:messageId,role:'user',source:{kind:'push-to-user',label:'dari',href:fileUrls.get(deliveryId+'-answer.md')!},content:[{type:'text',text:'Answer delivered: '+deliveryId}]});
   return {text:'Succeed\n-------\n- answer message: '+messageId+'\nThe Answer is delivered; do not repeat it. Use the following displayed data for observations; HTML/SVG reading is unnecessary.\n\n'+result.dataDocument};
  }
 })),{
  name:'dari_probe',description:'Read a small data sample to confirm values before writing the final draft, only when the result will change what you write. Every call must pass purpose: one sentence naming the decision this probe informs (for example "confirm whether test_y30071682 is a site or a tenant before choosing the filter"). Batch independent checks into one probe (up to 3 bindings), including different checks on the same dataset; split only when a later probe needs the previous result. A probe draft reads 1 to 3 query_remote! datasets. Each binding reads exactly one dataset: connect/join is not allowed, so split additional datasets into separate bindings. Each binding must filter, except a single-row probe with take(1) (for example the latest timestamp or a count) that may omit the filter; it may project any number of fields and must end with order_by(...) |> take(n) where 1 <= n <= 20; nothing is delivered to the conversation. Never use probe rows as the final answer: the final draft re-reads the data. If the result does not change your draft, write the final draft instead of probing again. The file must already exist: create it with the file tool in an earlier step and never batch that write with this call.',parameters:{type:'object',properties:{src:{type:'string',description:'工作区内的 .dari 文件路径（相对工作区或绝对路径），不是文件正文'},purpose:{type:'string',minLength:1,maxLength:200,description:'这次探测要改变哪个写法或结论（必填）'}},required:['src','purpose'],additionalProperties:false},output,
  async execute(args:{src:string;purpose:string},exec:ToolExec){
   if(Object.keys(args).some(k=>k!=='src'&&k!=='purpose'))throw Error('Only src and purpose are accepted');
   const purpose=typeof args.purpose==='string'?args.purpose.trim():'';
   if(!purpose)throw Error('dari_probe requires purpose: state which decision the result will change');
   const env=environment(exec);
   if(env.entry.settings.requireRunApproval)throw Error('DARI execution is unavailable when requireRunApproval is enabled');
   const result=await env.host.request({method:'probe',source:source(env.entry.root,args.src),context:env.context,contextContractId:'dari-context/v2'});exec.signal?.throwIfAborted();
   if(!result||typeof result.probe!=='object'||result.probe===null)throw Error('DARI service must provide probe result');
   return {text:renderProbe(result.probe,purpose)};
  }
 },{
  name:'dari_renew_context',description:'Start a fresh context time snapshot for this session. Takes src, the path of a local .dari file (not the source text). Subsequent dari_submit reads current data with the fresh snapshot.',parameters:{type:'object',properties:{src:{type:'string',description:'工作区内的 .dari 文件路径（相对工作区或绝对路径），不是文件正文'}},required:['src'],additionalProperties:false},output,
  async execute(args:{src:string},exec){const env=environment(exec);source(env.entry.root,args.src);contexts.delete(env.key);return {text:'Succeed\n-------\nContext renewed'};}
 }];
 return {tools,async infoContracts(points:any[],exec:ToolExec){
  exec.signal?.throwIfAborted();const entry=options.knowledge.ensureWorkspace(exec);
  const result=await worker(entry.settings.dataFile??'',entry.settings.model).request({method:'inspect',input:points});exec.signal?.throwIfAborted();return result;
 },dispose(){closed=true;for(const {child}of workers.values()){child.stdin.end();const timer=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}},2000);timer.unref();child.once('exit',()=>clearTimeout(timer));}workers.clear();contexts.clear();}};
}
