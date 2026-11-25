import {modelErrorText,ModelCheckFailure,type InputOrigin} from '@local/dari-core';
import {sharedTypes} from '@local/dari-core';
import {Worker} from 'node:worker_threads';
import {accessSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve as pathResolve} from 'node:path';
import type {ModelCheckPort,IntentType,MemberSymbol,DatasetSymbol,RelationSymbol,ResultColumn,ValueCodec} from '@local/dari-core';
import {MODEL_ABI_VERSION,type EncodedIntent,type ProofReceipt} from '@local/dari-core';
import type {Type} from '@local/dari-core';
import {primaryCodecs} from '@local/dari-core/codecs';

type WireMember={id:string;symbol:string;kind:'dimension'|'measure';logical:string;storage:string;nullable:boolean};
type WireDataset={id:string;symbol:string;members:WireMember[]};
type WireTemplate={container:'table'|'option';receipt:ProofReceipt;sql:string;bindings:any[];columns:(ResultColumn&{logical:string})[];max_rows:number|null};
export async function openModel(artifact:string){
    accessSync(artifact);
    const buffer=new SharedArrayBuffer(8+8*1024*1024),state=new Int32Array(buffer,0,2),bytes=new Uint8Array(buffer,8);
    const worker=new Worker(new URL('./model-worker.mjs',import.meta.url),{execArgv:[],workerData:{buffer,artifact:pathResolve(artifact)}});
    const stats={requests:0,checkMs:[] as number[],contractMs:0};
    let closed=false;const exited=new Promise<void>(resolve=>worker.once('exit',()=>resolve()));
    // 服务集合模型（多个 service slot）把路由放在 method、ABI 方法放进 input，
    // 输出再包一层 body；首次探测到该协议后固定使用。
    let route:string|undefined;
    // 检测到服务集合协议（响应带 body）后，check 也使用集合模型的 ABI 方法名。
    let collection=false;
    function send(method:string,input:unknown,origins:InputOrigin[],at:string|undefined):any{
        if(closed)throw Error('Model bridge is closed');
        Atomics.store(state,0,0);worker.postMessage({method,input,origins,...(at===undefined?{}:{route:at})});
        if(Atomics.wait(state,0,0,60000)==='timed-out'){closed=true;void worker.terminate();throw Error('Model ABI request timed out');}
        const response=JSON.parse(new TextDecoder().decode(bytes.subarray(0,Atomics.load(state,1))));
        stats.requests++;return response;
    }
    function request(method:string,input:unknown,origins:InputOrigin[]=[]):any{
        let response=send(method,input,origins,route);
        if(route===undefined&&response.error!==undefined&&JSON.stringify(response.error).includes('unknown service route')){
            route='ontology/model';
            response=send(method,input,origins,route);
        }
        if(response.error){if(Array.isArray(response.error))throw new ModelCheckFailure(response.error);throw Error(modelErrorText(response.error));}
        // 服务集合模型把服务输出放在 body 里，并在同一层给出 contract_id；单服务模型直接返回结果。
        const value=response.value;
        if(value!==null&&typeof value==='object'&&!Array.isArray(value)
            &&value.body!==null&&typeof value.body==='object'&&!Array.isArray(value.body)){
            collection=true;
            return value.contract_id!==undefined&&value.body.contract_id===undefined
                ?{...value.body,contract_id:value.contract_id}:value.body;
        }
        return value;
    }
    function scalar(name:string):Type{return sharedTypes[name]??{kind:'scalar',name};}
    const types:Record<string,Type>=Object.create(null),businessTypes=new Map<string,Type>(),resolvingMeans=new Set<string>();
    let meanResults:Record<string,{logical:string;storage:string}>;
    let codecs:Record<string,ValueCodec>,presentations:Record<string,Type["presentation"]>,semantics:Record<string,{identity?:string;semantic?:string}>;
    function business(logical:string,physical:string):Type{
        const key=logical+'@'+physical;
        if(resolvingMeans.has(key))throw Error('Cyclic model mean result type '+key);
        const previous=businessTypes.get(key);
        if(previous)return previous;
        const primary=Object.hasOwn(primaryCodecs,logical),specific=codecs[key];
        // 服务集合模型把枚举列发布为 logical="String" + storage="Float"，且没有该组合的 codec；
        // 这类列按 logical 的类型与主编码器处理（SQL 实际返回文本值）。
        const byLogical=primary&&specific===undefined&&logical!==physical;
        const base=scalar(byLogical?logical:physical);
        const codec=byLogical?primaryCodecs[logical]:(primary?primaryCodecs[physical]:specific);
        if(!codec)throw Error('Missing model type codec '+key);
        const metadata=semantics?.[key],shared=metadata?.identity?sharedTypes[metadata.identity]:undefined;
        if(metadata?.identity&&!shared)throw Error('Unknown shared ontology type '+metadata.identity);
        if(shared&&JSON.stringify(shared.codec?.operations)!==JSON.stringify(codec.operations))throw Error('Shared type calculation contract mismatch '+metadata!.identity);
        const type:Type=shared??(primary?{...base,codec}:{kind:'nominal',name:logical,inner:base,codec,semantic:metadata?.semantic??undefined,presentation:presentations?.[key]??undefined});
        const published={...type,modelLogical:logical};
        businessTypes.set(key,published);
        const mean=meanResults?.[key];
        if(mean){resolvingMeans.add(key);try{published.meanResult=business(mean.logical,mean.storage);}finally{resolvingMeans.delete(key);}}
        return published;
    }
    const started=performance.now();
    let contract:{contract_id:string;abi_version:string;datasets:WireDataset[];relations:Omit<RelationSymbol,'kind'>[];types:{name:string;logical:string;storage:string}[];codec_module:string};
    try{
        contract=request('ontology/model',{method:'contract',input:{}});
        if(contract.abi_version!==MODEL_ABI_VERSION)throw Error('Unsupported model proof ABI '+contract.abi_version);
        // Trusted model build output; .dari text is never executed as JavaScript.
        const generated=await import('data:text/javascript;base64,'+Buffer.from(contract.codec_module).toString('base64'));
        codecs=generated.createCodecs(primaryCodecs);presentations=generated.presentations;semantics=generated.semantics;meanResults=generated.meanResults??{};
        if(!presentations||!semantics)throw Error('Model must publish independent semantic and presentation contracts');
        for(const t of contract.types){
            types[t.name]=business(t.logical,t.storage);
            if(types[t.name].kind==='nominal'&&!Object.hasOwn(sharedTypes,types[t.name].name??''))types[t.name].displayName=t.name;
        }
    }catch(e){worker.postMessage({close:true});throw e;}
    stats.contractMs=performance.now()-started;
    const datasets:Record<string,DatasetSymbol>=Object.create(null);
    for(const item of contract.datasets){
        const members:Record<string,MemberSymbol>=Object.create(null);
        for(const m of item.members){
            if(Object.hasOwn(members,m.symbol))throw Error('Ambiguous published model member '+item.symbol+'.'+m.symbol);
            const type=business(m.logical,m.storage);
            members[m.symbol]={kind:m.kind,id:m.id,symbol:m.symbol,owner:item.id,type:m.nullable?{kind:'option',inner:type}:type};
        }
        if(Object.hasOwn(datasets,item.symbol))throw Error('Ambiguous published Dataset '+item.symbol);
        datasets[item.symbol]={kind:'dataset',id:item.id,symbol:item.symbol,members};
    }
    const model:ModelCheckPort={
        contractId:contract.contract_id,
        implementationId:createHash('sha256').update(readFileSync(artifact)).digest('hex'),
        datasets,types,relations:Object.fromEntries(contract.relations.map(r=>[r.symbol,{...r,kind:'relation' as const}])),
        check_type(intent:IntentType,encoded:EncodedIntent){
            const start=performance.now();
            // 服务集合模型（semora）用 check_type + intent_json；单服务模型用 transform + intent。
            const checked:WireTemplate=collection
                ?request('ontology/model',{method:'check_type',input:{intent_json:encoded.json}})
                :request('ontology/model',{method:'transform',input:{intent:encoded.wire}},encoded.origins.map(o=>({...o,path:['input','intent',...o.path]})));
            stats.checkMs.push(performance.now()-start);
            const fields:Record<string,Type>=Object.create(null);
            for(const c of checked.columns){const t=business(c.logical,c.type);fields[c.name]=c.nullable?{kind:'option',inner:t}:t;}
            return {element:{kind:'schema',fields},container:checked.container,receipt:checked.receipt,maxRows:checked.max_rows??undefined,plan:{checked,constants:encoded.constants,parameterTypes:encoded.parameterTypes}};
        }
    };
    function bind(plan:unknown,parameters:unknown[]){
            const {checked,constants,parameterTypes}=plan as {checked:WireTemplate;constants:Map<number,unknown>;parameterTypes:Map<number,Type>};
            const bindings:any[]=[];
            // Scan SQL tokens: placeholders in quoted text/comments are not bindings.
            const sql=checked.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?(\d+)|:__dari_(\d+)/g,(token,constant,parameter)=>{
                if(constant===undefined&&parameter===undefined)return token;
                const index=Number(parameter);
                const value=constant!==undefined?checked.bindings[Number(constant)-1]:constants.has(index)?constants.get(index):parameters[index];
                if(value===undefined)throw Error('Missing model binding');
                let type=parameterTypes.get(index);
                if(type?.kind==='option')type=type.inner;
                const unwrapped=value?.tag==='None'?null:value?.tag==='Some'?value.value:value;
                bindings.push(parameter!==undefined&&unwrapped!==null&&type?.codec?type.codec.encode(unwrapped):unwrapped);return '?';
            });
            return {sql,bindings,columns:checked.columns.map(({logical,...column})=>column),max_rows:checked.max_rows??undefined};
    }
    return {model,bind,stats,contract,codecs,codecModuleSource:contract.codec_module,
        checkWire(intentJson:string):WireTemplate{return request('ontology/model',{method:'transform',input:{intent:JSON.parse(intentJson)}});},
        async close(){if(!closed){closed=true;worker.postMessage({close:true});}await exited;}};
}
