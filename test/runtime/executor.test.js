import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt';
import {ToolsService,projectToolSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools';
import {ToolExecutionPipeline,executeToolBatch} from '@deepseek-ai/dsh-tools/pipeline';
import {NativeToolExecutor} from '@deepseek-ai/dsh-tool-executor-native';
import {createScope,scopeTarget} from '@deepseek-ai/dsh-scope';
import {CapabilityExecutor} from '../../src/executor.js';
import {normalizeConfig} from '../../src/config.js';
import * as plugin from '../../src/index.js';
import {assertReleasedV4Relationships} from '@deepseek-ai/dsh-session-format-v3-to-v4';
import {KNOWN_SESSION_EVENT_TYPES} from '@deepseek-ai/dsh-session';
import {createAssistantMessage} from '@deepseek-ai/dsh-llm';

const kernel={projectToolSchema,validateJsonSchemaValue,ToolExecutionPipeline,executeToolBatch};
function fixture(name,body=async args=>args,extra={}) {
  return {name,description:`Fixture ${name}`,parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:body,...extra};
}
async function harness(t) {
  const root=new Context();await root.plugin(SystemPrompt,{includeHarnessIdentity:false});await root.plugin(ToolsService,{});
  let ctx;await root.plugin({name:'fixture-host',inject:['tools','systemPrompt'],apply(c){ctx=c;c.tools.setExecutor(new NativeToolExecutor(c));}});
  await root.fiber.await();
  t.after(()=>root.fiber.dispose());
  const events=[];const agent={id:'runtime-fixture',session:{append(type,data){events.push({type,data});return {seq:events.length};}}};
  const scope=createScope(ctx,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose());
  const executor=new CapabilityExecutor(ctx,normalizeConfig({pinnedTools:['read']}),kernel,{agent});
  scope.ctx.get('tools').setExecutor(executor);
  let id=0;
  const admit=()=>ctx.tools.resolve({agent,signal:new AbortController().signal,modelSelection:{provider:'fixture',model:'fixture'}});
  async function call(name,args,{signal=new AbortController().signal,toolSet}={}) {
    const selected=toolSet ?? await admit();
    try{return (await executor.execute({calls:[{type:'tool-call',id:`call-${++id}`,name,arguments:JSON.stringify(args)}],agent,toolSet:selected,signal,log:{turn:1,step:id}})).results[0].result;}
    finally{if(!toolSet) selected.dispose();}
  }
  return {root,ctx,scope,agent,executor,events,call,admit};
}
test('real DSH registry folds 300 tools without deleting or restricting them; selected schema only',async t=>{
  const h=await harness(t);
  h.ctx.tools.register(fixture('read'));
  for(let i=0;i<300;i++)h.ctx.tools.register(fixture(`mcp__demo__operation_${i}`));
  const before=h.executor.describe(h.ctx.tools.definitions(h.agent));
  assert.deepEqual(before.schemas.map(x=>x.name),['read','capability_search','capability_describe','capability_call']);
  const found=await h.call('capability_search',{query:'mcp__demo__operation_299'});
  assert.equal(found.value.matches[0].id,'mcp__demo__operation_299');
  const described=await h.call('capability_describe',{ids:['mcp__demo__operation_299']});
  assert.equal(described.value.tools.length,1);
  const result=await h.call('capability_call',{id:'mcp__demo__operation_299',args:{value:'ok'},version:described.value.tools[0].version});
  assert.equal(result.value.value,'ok');
  assert.equal(JSON.stringify(before.schemas),JSON.stringify(h.executor.describe(h.ctx.tools.definitions(h.agent)).schemas));
  assert.ok(h.ctx.tools.executable('mcp__demo__operation_1',h.agent));
});
test('real guards, scope restrictions, conditional admission and stale schemas prevent business calls',async t=>{
  const h=await harness(t);let writes=0;
  h.ctx.tools.register(fixture('guarded',async a=>{writes++;return a;}));
  h.ctx.tools.guard(exec=>exec.name==='guarded'?'fixture permission denied':undefined);
  assert.equal((await h.call('capability_call',{id:'guarded',args:{value:'no'}})).isError,true);assert.equal(writes,0);
  h.ctx.tools.register(fixture('hidden'));
  h.scope.ctx.get('tools').restrict({deny:['hidden']});
  assert.equal((await h.call('capability_search',{query:'hidden'})).value.total,0);
  assert.deepEqual((await h.call('capability_describe',{ids:['hidden']})).value.notFound,['hidden']);
  assert.equal((await h.call('capability_call',{id:'hidden',args:{value:'no'}})).isError,true);
  h.ctx.tools.register(fixture('conditional'),{when:()=>false});
  assert.equal((await h.call('capability_call',{id:'conditional',args:{value:'no'}})).isError,true);
  h.ctx.tools.register(fixture('versioned',async a=>{writes++;return a;}));
  assert.equal((await h.call('capability_call',{id:'versioned',args:{value:'no'},version:'obsolete'})).isError,true);
  assert.equal((await h.call('capability_call',{id:'versioned',args:{wrong:'no'}})).isError,true);assert.equal(writes,0);
});
test('new registrations wait for new step admission, and removed tools cannot run',async t=>{
  const h=await harness(t);const selected=await h.admit();
  const unregister=h.ctx.tools.register(fixture('newly_installed'));
  assert.equal((await h.call('capability_call',{id:'newly_installed',args:{value:'a'}},{toolSet:selected})).isError,true);selected.dispose();
  assert.equal((await h.call('capability_call',{id:'newly_installed',args:{value:'a'}})).isError,false);
  const snapshot=await h.admit();unregister();
  assert.equal((await h.call('capability_call',{id:'newly_installed',args:{value:'b'}},{toolSet:snapshot})).isError,true);snapshot.dispose();
});
test('native media, metadata, finalizers, additional context, conclusion and IDs survive exactly once',async t=>{
  const h=await harness(t);let posts=0,finalized=0;
  const media=[{type:'text',text:'metric=59.7139'}, {type:'image',attachment:{id:'image-fixture',mimeType:'image/png'}}];
  h.ctx.tools.register(fixture('media',async(args,exec)=>{exec.deferContext({content:[{type:'text',text:'extra context'}]});exec.concludeTurn();return args;},{
    output:{schema:{type:'object'},render:()=>media,presentationMeta:()=>({card:'fixture'})},
    finalizeContent:(_exec,result)=>{finalized++;return result.content;},
    presentCall:args=>({card:'generic',title:'Original media call',rawInput:args}),
    presentResult:()=>({card:'generic',title:'Original media result'}),
  }));
  h.ctx.on('tools/post-execute',async(_exec,result,next)=>{posts++;return next();});
  const result=await h.call('capability_call',{id:'media',args:{value:'image'}});
  assert.equal(result.isError,false);assert.deepEqual(result.content,media);assert.deepEqual(result.meta,{card:'fixture'});
  assert.equal(result.additionalContexts.length,1);assert.equal(result.concludesTurn,true);assert.equal(finalized,1);assert.equal(posts,1);
  assert.equal(h.events.find(e=>e.type==='tool/call').data.name,'capability_call');
  assert.deepEqual(JSON.parse(h.events.find(e=>e.type==='tool/call').data.arguments),{id:'media',args:{value:'image'}});
  assert.equal(JSON.parse(h.events.find(e=>e.type==='tool/call').data.arguments).id,'media');
  assert.equal(h.events.find(e=>e.type==='tool/result').data.message.toolCallId,h.events.find(e=>e.type==='tool/call').data.callId);
  assert.equal(h.events.filter(e=>e.type==='tool/call').length,1);
  const bridge=h.ctx.tools.get('capability_call',h.agent);
  assert.equal(bridge.presentCall({id:'media',args:{value:'image'}}).title,'Original media call');
  assert.equal(bridge.presentResult({id:'media',args:{value:'image'}},result).title,'Original media result');
});
test('cancellation drains started work and never automatically replays side effects',async t=>{
  const h=await harness(t);let starts=0,settled=false;
  h.ctx.tools.register(fixture('slow_write',async(args,exec)=>{starts++;await new Promise(resolve=>exec.signal.addEventListener('abort',()=>setTimeout(resolve,15),{once:true}));settled=true;return args;}));
  const controller=new AbortController();const pending=h.call('capability_call',{id:'slow_write',args:{value:'x'}},{signal:controller.signal});
  setTimeout(()=>controller.abort(),20);const result=await pending;
  assert.equal(result.isError,true);assert.equal(starts,1);assert.equal(settled,true);
});
test('plugin lifecycle attaches only to native mode, restores it on unload, leaves PTC untouched',async t=>{
  const h=await harness(t);
  const other={id:'plugin-agent',session:h.agent.session};const scope=createScope(h.ctx,other);other.ctx=scope.ctx;t.after(()=>scope.dispose());
  const before=h.ctx.tools.selectExecutor(other);assert.equal(before.constructor.name,'NativeToolExecutor');
  const fork=h.ctx.plugin(plugin,{servers:[]});await fork;
  await h.ctx.serial(scopeTarget(h.ctx,other),'agent/created',{agent:other,source:'startup'});
  assert.equal(h.ctx.tools.selectExecutor(other).constructor.name,'CapabilityExecutor');
  const ptcAgent={id:'ptc'};const ptcScope=createScope(h.ctx,ptcAgent);ptcAgent.ctx=ptcScope.ctx;t.after(()=>ptcScope.dispose());
  class PtcExecutor{describe(){return {schemas:[]};}execute(){}}
  const ptc=new PtcExecutor();ptcScope.ctx.get('tools').setExecutor(ptc);
  await h.ctx.serial(scopeTarget(h.ctx,ptcAgent),'agent/created',{agent:ptcAgent,source:'startup'});
  assert.equal(h.ctx.tools.selectExecutor(ptcAgent),ptc);
  await fork.dispose();assert.equal(h.ctx.tools.selectExecutor(other),before);
  const reload=h.ctx.plugin(plugin,{servers:[]});await reload;
  await h.ctx.serial(scopeTarget(h.ctx,other),'agent/created',{agent:other,source:'resume'});
  assert.equal(h.ctx.tools.selectExecutor(other).constructor.name,'CapabilityExecutor');
  await reload.dispose();assert.equal(h.ctx.tools.selectExecutor(other),before);
});
test('bounded concurrency and exclusive barriers retain native scheduling',async t=>{
  const h=await harness(t);h.executor.config.maxParallel=2;
  let active=0,peak=0;const sequence=[];
  h.ctx.tools.register(fixture('parallel',async args=>{active++;peak=Math.max(peak,active);sequence.push('start-'+args.value);await new Promise(resolve=>setTimeout(resolve,20));active--;sequence.push('end-'+args.value);return args;},{isConcurrencySafe:()=>true}));
  h.ctx.tools.register(fixture('exclusive',async args=>{assert.equal(active,0);sequence.push('exclusive');return args;}));
  const selected=await h.admit();
  const calls=['parallel','parallel','parallel','exclusive','parallel'].map((id,i)=>({type:'tool-call',id:'batch-'+i,name:'capability_call',arguments:JSON.stringify({id,args:{value:String(i)}})}));
  const result=await h.executor.execute({calls,agent:h.agent,toolSet:selected,signal:new AbortController().signal});selected.dispose();
  assert.equal(peak,2);assert.ok(result.results.every(r=>!r.result.isError));
  assert.ok(sequence.indexOf('exclusive')>sequence.indexOf('end-2'));
  assert.ok(sequence.indexOf('start-4')>sequence.indexOf('exclusive'));
});
test('child agents inherit parent restrictions and cannot impersonate another scope',async t=>{
  const h=await harness(t);h.ctx.tools.register(fixture('parent_denied'));h.ctx.tools.register(fixture('read'));
  h.scope.ctx.get('tools').restrict({deny:['parent_denied']});
  const child={id:'child'};const scope=createScope(h.ctx,child,{parent:h.agent});child.ctx=scope.ctx;t.after(()=>scope.dispose());
  const executor=new CapabilityExecutor(h.ctx,normalizeConfig(),kernel,{agent:child});scope.ctx.get('tools').setExecutor(executor);
  const selected=await h.ctx.tools.resolve({agent:child,signal:new AbortController().signal,modelSelection:{provider:'fixture',model:'fixture'}});
  const result=await executor.execute({calls:[{type:'tool-call',id:'child-call',name:'capability_describe',arguments:JSON.stringify({ids:['parent_denied']})}],agent:child,toolSet:selected,signal:new AbortController().signal});selected.dispose();
  assert.deepEqual(result.results[0].result.value.notFound,['parent_denied']);
  assert.throws(()=>executor.execute({calls:[],agent:h.agent,signal:new AbortController().signal}),/Wrong agent/);
});
test('native V4 persistence validator accepts routed history and rejects mismatched execution names',async t=>{
  const h=await harness(t);h.ctx.tools.register(fixture('actual_tool'));
  const args={id:'actual_tool',args:{value:'replay'}};
  await h.call('capability_call',args);
  const call=h.events.find(e=>e.type==='tool/call').data;
  const message=createAssistantMessage({content:[{type:'tool-call',id:call.callId,name:'capability_call',arguments:JSON.stringify(args)}]});
  const events=[
    {type:'turn/start',data:{turn:1}},
    {type:'step/start',data:{turn:1,step:1}},
    {type:'assistant/message',data:{turn:1,step:1,message},surfaceOp:'append'},
    ...h.events.map(e=>({...e,...(e.type==='tool/result'?{surfaceOp:'append'}:{})})),
    {type:'step/end',data:{turn:1,step:1}},
    {type:'turn/end',data:{turn:1}},
  ].map((e,seq)=>({...e,seq,time:Date.now()}));
  const artifact={header:{id:'persistence-fixture'},events,inheritedEventCount:0};
  const known=new Set(KNOWN_SESSION_EVENT_TYPES);
  assert.doesNotThrow(()=>assertReleasedV4Relationships(artifact,known));
  const broken=structuredClone(artifact);broken.events.find(e=>e.type==='tool/call').data.name='actual_tool';
  assert.throws(()=>assertReleasedV4Relationships(broken,known),/does not match one advertised tool call/);
});
