import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lazyValidator } from './lazy-validator.js';

function digest(value) {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function publicName(server,raw) {
  const full=`mcp__${server}__${raw}`,clean=full.replace(/[^A-Za-z0-9_-]/g,'_');
  const hash=createHash('sha256').update(server+'\0'+raw).digest('hex').slice(0,12);
  return full===clean && full.length<=64 ? full : `${clean.slice(0,51)}_${hash}`;
}
function metadata(tool) {
  if (!tool || typeof tool.name!=='string' || !tool.name || !tool.inputSchema || typeof tool.inputSchema!=='object') throw new Error('Invalid MCP metadata');
  return {name:tool.name,description:String(tool.description ?? ''),inputSchema:tool.inputSchema,
    ...(tool.outputSchema ? {outputSchema:tool.outputSchema}:{}),...(tool.execution ? {execution:tool.execution}:{})};
}
const waitFor = (promise,signal) => {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason);};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    promise.then(x=>{cleanup();resolve(x);},e=>{cleanup();reject(e);});
  });
};
/** Owns only explicitly configured MCP sources; never closes another plugin's clients. */
export class ManagedServers {
  constructor(ctx,config,{createMcpToolDefinition}) {
    this.ctx=ctx;this.tools=ctx.get('tools');this.config=config;this.createDefinition=createMcpToolDefinition;
    this.directory=config.cacheDir ?? join(process.env.DSH_HOME ?? join(homedir(),'.dsh'),'storages','capability-router');
    this.sources=new Map(config.servers.map(entry=>[entry.serverName,{entry,fingerprint:digest(entry),registered:new Map(),raw:new Map(),calls:new Set(),client:null,pending:null,lastUsed:0,state:'cold'}]));
    this.stopping=false;
  }
  async initialize() {
    for (const source of this.sources.values()) {
      try {
        const cached=JSON.parse(await fs.readFile(this.path(source),'utf8'));
        if (cached.version===1 && cached.fingerprint===source.fingerprint && Array.isArray(cached.tools)) {
          this.register(source,cached.tools.map(metadata));source.instructions=typeof cached.instructions==='string'?cached.instructions:'';
        }
      } catch { /* A cache is optional and never a source of authorization. */ }
    }
    this.timer=setInterval(()=>{void this.reap();},1000);this.timer.unref();
  }
  path(source) {return join(this.directory,source.entry.serverName+'.json');}
  isCold(name) {return this.sources.has(name) && this.sources.get(name).registered.size===0;}
  instructionsFor(names) {return Object.fromEntries([...new Set(names)].filter(n=>this.sources.get(n)?.instructions).map(n=>[n,this.sources.get(n).instructions]));}
  status() {return [...this.sources].map(([source,s])=>({source,state:s.state,tools:s.registered.size,inFlight:s.calls.size,stateless:s.entry.stateless===true}));}
  async discover(name,signal) {
    const source=this.sources.get(name);if (!source) throw new Error('Unknown managed source');
    await waitFor(this.connect(source),signal);
  }
  register(source,rawTools) {
    const names=new Set();
    for(const tool of rawTools) {
      const name=publicName(source.entry.serverName,tool.name);
      if(names.has(name)) throw new Error('Duplicate MCP tool identity');names.add(name);
      const old=source.registered.get(name);
      if(!old && this.tools.get(name)) throw new Error(`MCP ownership conflict: ${source.entry.serverName}; disable its duplicate native client, not its capabilities`);
    }
    for(const tool of rawTools) {
      const name=publicName(source.entry.serverName,tool.name),version=digest(tool),old=source.registered.get(name);
      if(old?.version===version) continue;
      // Build and validate the replacement before releasing its previous owner.
      const definition=this.createDefinition(this.ctx,{
        name,rawName:tool.name,description:tool.description,inputSchema:tool.inputSchema,outputSchema:tool.outputSchema,
        taskRequired:tool.execution?.taskSupport==='required',
        call:(args,exec)=>this.call(source,tool.name,version,args,exec.signal),
      });
      old?.dispose();
      source.registered.set(name,{version,dispose:this.tools.register(definition)});
    }
    for(const [name,entry] of source.registered) if(!names.has(name)){entry.dispose();source.registered.delete(name);}
    source.raw=new Map(rawTools.map(t=>[t.name,t]));
    if(!source.client) source.state='cached';
  }
  connect(source) {
    if(this.stopping) return Promise.reject(new Error('Managed MCP owner is stopping'));
    if(source.pending) return source.pending;
    if(source.client) return Promise.resolve(source.client);
    source.pending=this.open(source).finally(()=>{source.pending=null;});
    return source.pending;
  }
  async open(source) {
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
    const entry=source.entry;
    let transport;
    if(entry.transport==='stdio') {
      const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
      const proxies=Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
      transport=new StdioClientTransport({command:entry.command,args:entry.args ?? [],cwd:entry.cwd,env:{...proxies,...entry.env},stderr:'pipe'});
    } else {
      const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      transport=new StreamableHTTPClientTransport(new URL(entry.url),{requestInit:{headers:entry.headers ?? {}}});
    }
    const {AjvJsonSchemaValidator}=await import('@modelcontextprotocol/sdk/validation/ajv');
    const client=new Client({name:'dsh-capability-router',version:'0.1.0'},{jsonSchemaValidator:lazyValidator(new AjvJsonSchemaValidator())});
    source.state='connecting';
    const controller=new AbortController();
    const timer=setTimeout(()=>{controller.abort(new Error('MCP_CONNECT_TIMEOUT'));void client.close();},entry.connectTimeoutMs ?? 30000);
    timer.unref();
    try {
      transport.stderr?.resume();
      await client.connect(transport,{signal:controller.signal,timeout:entry.connectTimeoutMs ?? 30000});
      transport.stderr?.resume(); // Drain stderr without leaking source credentials to model/logs.
      const tools=[];let cursor;const visited=new Set();
      do {
        if(cursor && visited.has(cursor)) throw new Error('Repeated MCP catalog cursor');
        if(cursor) visited.add(cursor);
        const page=await client.listTools(cursor ? {cursor}:{},{signal:controller.signal});
        tools.push(...page.tools.map(metadata));cursor=page.nextCursor;
        if(visited.size>1000) throw new Error('MCP catalog exceeds pagination bound');
      } while(cursor);
      if(this.stopping) throw new Error('Owner is stopping');
      this.register(source,tools);source.instructions=client.getInstructions() ?? '';source.client=client;source.state='connected';source.lastUsed=Date.now();
      client.onclose=()=>{if(source.client===client){source.client=null;source.state=source.registered.size?'cached':'cold';}};
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      const temp=this.path(source)+'.'+randomUUID()+'.tmp';
      try {
        await fs.writeFile(temp,JSON.stringify({version:1,fingerprint:source.fingerprint,tools,instructions:source.instructions}),{mode:0o600});
        await fs.rename(temp,this.path(source));
      } finally {await fs.rm(temp,{force:true});}
      return client;
    } catch {
      await client.close().catch(()=>{});await transport.close().catch(()=>{});
      if(source.client===client) source.client=null;
      source.state='unavailable';
      // Do not copy upstream messages or stderr: they may include credentials.
      throw new Error(`Managed source ${entry.serverName} is unavailable; no business call was retried`);
    } finally {clearTimeout(timer);}
  }
  async call(source,rawName,version,args,signal) {
    signal.throwIfAborted();
    const operation=(async()=>{
      const client=await waitFor(this.connect(source),signal);
      signal.throwIfAborted();
      const current=source.raw.get(rawName);
      if(!current || digest(current)!==version) throw new Error('SCHEMA_CHANGED: discover and describe again; no business call was made');
      // Exactly one attempt. A transport error after dispatch is an unknown outcome.
      try {return await client.callTool({name:rawName,arguments:args},undefined,{signal,timeout:source.entry.toolCallTimeoutMs ?? 60000});}
      catch {if(signal.aborted) throw signal.reason;throw new Error('MCP_CALL_OUTCOME_UNKNOWN: inspect source state before retrying a write; no automatic replay');}
    })();
    source.calls.add(operation);
    try{return await operation;}finally{source.calls.delete(operation);source.lastUsed=Date.now();}
  }
  async reap() {
    for(const source of this.sources.values()) {
      const timeout=source.entry.stateless===true ? (source.entry.idleTimeoutMs ?? 600000):0;
      if(timeout>0 && source.client && !source.pending && source.calls.size===0 && Date.now()-source.lastUsed>=timeout) {
        const client=source.client;source.client=null;source.state='cached';await client.close().catch(()=>{});
      }
    }
  }
  async dispose() {
    this.stopping=true;clearInterval(this.timer);
    await Promise.allSettled([...this.sources.values()].map(async source=>{
      if(source.pending) await source.pending.catch(()=>{});
      await source.client?.close().catch(()=>{});
      await Promise.allSettled([...source.calls]);
      for(const {dispose} of source.registered.values())dispose();
      source.registered.clear();source.client=null;
    }));
  }
}
