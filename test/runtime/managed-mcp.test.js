import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt';
import {ToolsService} from '@deepseek-ai/dsh-tools';
import {createMcpToolDefinition} from '@deepseek-ai/dsh-mcp-client';
import {ManagedServers,publicName} from '../../src/managed-mcp.js';
import {normalizeConfig} from '../../src/config.js';

async function setup(t,{stateless=true}={}) {
  const directory=await mkdtemp(join(tmpdir(),'router-mcp-test-'));
  const root=new Context();await root.plugin(SystemPrompt,{});await root.plugin(ToolsService,{});
  let ctx;await root.plugin({name:'managed-fixture',inject:['tools'],apply(c){ctx=c;}});await root.fiber.await();
  const config=normalizeConfig({cacheDir:join(directory,'cache'),servers:[{serverName:'fixture',transport:'stdio',command:process.execPath,args:[fileURLToPath(new URL('../fixtures/mcp-server.mjs',import.meta.url))],env:{FIXTURE_STATE_DIR:directory},stateless,...(stateless?{idleTimeoutMs:30}:{}),connectTimeoutMs:5000}]});
  let manager=new ManagedServers(ctx,config,{createMcpToolDefinition});await manager.initialize();
  t.after(async()=>{await manager.dispose();await root.fiber.dispose();await rm(directory,{recursive:true,force:true});});
  return {directory,ctx,config,get manager(){return manager;},async restart(){await manager.dispose();manager=new ManagedServers(ctx,config,{createMcpToolDefinition});await manager.initialize();}};
}
const count=async(file)=>{try{return (await readFile(file,'utf8')).trim().split('\n').filter(Boolean).length;}catch{return 0;}};
test('cold/cached discovery, simultaneous first use, idle stop and reconnect use one owner',async t=>{
  const h=await setup(t);assert.equal(await count(join(h.directory,'starts')),0);
  await Promise.all([h.manager.discover('fixture'),h.manager.discover('fixture')]);
  assert.equal(await count(join(h.directory,'starts')),1);assert.equal(h.manager.status()[0].tools,3);
  assert.match(h.manager.instructionsFor(['fixture']).fixture,/read-only/);
  const tool=h.ctx.tools.get('mcp__fixture__echo');
  const signal=new AbortController().signal;
  const value=await tool.execute({value:'ok'},{signal});assert.equal(value.content[0].text,'ok');
  const wait=h.ctx.tools.get('mcp__fixture__wait').execute({value:'wait'},{signal});
  await new Promise(resolve=>setTimeout(resolve,45));await h.manager.reap();assert.equal(h.manager.status()[0].state,'connected');await wait;
  await new Promise(resolve=>setTimeout(resolve,45));await h.manager.reap();assert.equal(h.manager.status()[0].state,'cached');
  await h.restart();assert.equal(h.manager.status()[0].tools,3);assert.equal(await count(join(h.directory,'starts')),1);
  await h.ctx.tools.get('mcp__fixture__echo').execute({value:'cached'},{signal});assert.equal(await count(join(h.directory,'starts')),2);
});
test('stateful connections are never idled and schema changes reject stale cached calls',async t=>{
  const h=await setup(t,{stateless:false});await h.manager.discover('fixture');
  await new Promise(resolve=>setTimeout(resolve,45));await h.manager.reap();assert.equal(h.manager.status()[0].state,'connected');
  await h.restart();const old=h.ctx.tools.get('mcp__fixture__echo');await writeFile(join(h.directory,'changed'),'yes');
  await assert.rejects(old.execute({value:'stale'},{signal:new AbortController().signal}),/SCHEMA_CHANGED/);
  assert.equal(await count(join(h.directory,'calls')),0);
  assert.equal((await h.ctx.tools.get('mcp__fixture__echo').execute({value:'new'},{signal:new AbortController().signal})).content[0].text,'new');
});
test('a response lost after a write is an unknown outcome, never replayed',async t=>{
  const h=await setup(t);await h.manager.discover('fixture');
  await assert.rejects(h.ctx.tools.get('mcp__fixture__write_once').execute({value:'lose-response'},{signal:new AbortController().signal}),/OUTCOME_UNKNOWN/);
  assert.equal(await count(join(h.directory,'calls')),1);assert.equal(await count(join(h.directory,'starts')),1);
});
test('names are bounded and collision-resistant after sanitizing',()=>{
  assert.notEqual(publicName('demo','a.b'),publicName('demo','a-b'));
  assert.ok(publicName('demo','x'.repeat(150)).length<=64);
});
