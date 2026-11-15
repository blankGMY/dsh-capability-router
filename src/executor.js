import { BRIDGES, Catalog, sourceOf } from './catalog.js';

export class RouterInputError extends Error {
  constructor(message) { super(message); this.name = 'RouterInputError'; }
}
const object = (properties, required = []) => ({type:'object', properties, required, additionalProperties:false});
const text = description => ({type:'string', description});

/** Presentation is separate from admission. Never use tools.restrict to hide schemas. */
export class CapabilityExecutor {
  constructor(ctx, config, kernel, {agent, manager} = {}) {
    this.ctx = ctx; this.config = config; this.kernel = kernel; this.agent = agent; this.manager = manager;
    this.tools = ctx.get('tools'); this.catalog = new Catalog(config); this.pinned = new Set(config.pinnedTools);
    this.metrics = {descriptions:0, searches:0, calls:0, rejected:0, presented:0, available:0, schemaBytes:0};
    this.bridges = new Map(this.createBridges().map(d=>[d.name,d]));
    const bridge=this.bridges.get('capability_call');
    bridge.presentCall=args=>this.targetPresenter(args,'presentCall');
    bridge.presentResult=(args,result)=>this.targetPresenter(args,'presentResult',result);
    this.bridgeDisposers=[];
    if(agent?.ctx) for(const definition of this.bridges.values())this.bridgeDisposers.push(agent.ctx.get('tools').register(definition));
    this.sections = [{name:'tools:capability-router',order:195,interpolate:false,text:defs=>{
      const text=this.catalog.guidance(defs);
      const pending=this.manager?.status().filter(s=>s.tools===0).map(s=>s.source) ?? [];
      const hint=pending.length ? ` Configured sources awaiting discovery: ${pending.join(', ')}. Search with source to initialize their catalogs.`:'';
      return (text+hint).slice(0,this.config.sourceBudgetChars);
    }}];
    this.pipeline = new kernel.ToolExecutionPipeline(ctx, {
      get:(name,scope,toolSet)=>this.bridges.get(name) ?? this.tools.executable(name,scope,toolSet),
    });
  }
  dispose() {for(const dispose of this.bridgeDisposers)dispose();this.bridgeDisposers=[];}
  targetPresenter(args,method,result) {
    if(!args || typeof args.id!=='string')return undefined;
    const target=this.tools.get(args.id,this.agent);
    try{return method==='presentCall'?target?.presentCall?.(args.args):target?.presentResult?.(args.args,result);}catch{return undefined;}
  }
  available(exec) {
    if (this.agent && exec.agent !== this.agent) throw new RouterInputError('Wrong agent scope');
    return this.tools.definitions(exec.agent,exec.toolSet).filter(d=>!BRIDGES.includes(d.name) && this.tools.executable(d.name,exec.agent,exec.toolSet) === d);
  }
  assertArgs(schema,args) {
    const errors = this.kernel.validateJsonSchemaValue(schema,args,'arguments');
    if (errors.length) throw new RouterInputError(errors.join('; '));
  }
  createBridges() {
    const make = (name,description,parameters,body) => ({
      name,description,parameters,
      output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:async(args,exec)=>{this.assertArgs(parameters,args);return body(args,exec);},
    });
    return [
      make('capability_search',
        'Discover installed capabilities by words in Chinese/English, exact tool name, or source. Returns summaries, never all schemas. Empty query browses the complete paginated catalog. If a managed source is cold, specify source to discover its tools; retry after catalog-updated. Do not assume unavailable tools from the small direct list.',
        object({query:text('Task or tool keywords; empty browses.'),source:text('Optional source name from sources.'),cursor:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50}},['query']),
        async(args,exec)=>{
          this.metrics.searches++;
          // An owner may only discover a source explicitly configured on this host.
          if (args.source && this.manager?.isCold(args.source)) {
            await this.manager.discover(args.source,exec.signal);
            return {status:'catalog-updated',message:'Source discovered. Repeat search in the next model step so normal step admission includes its tools.'};
          }
          return {...this.catalog.search(this.available(exec),args), managedSources:this.manager?.status() ?? []};
        }),
      make('capability_describe',
        'Read complete parameters of exact tool IDs from capability_search. Returns only selected definitions, plus version tokens. Definitions are not permanently promoted. Reuse a still-current definition already present in context.',
        object({ids:{type:'array',items:{type:'string'},minItems:1,maxItems:5}},['ids']),
        (args,exec)=>{
          this.metrics.descriptions++;
          const allowed = new Map(this.available(exec).map(d=>[d.name,d]));
          const tools=[],notFound=[];
          for (const id of [...new Set(args.ids)]) {
            const def=allowed.get(id);
            if (!def) {notFound.push(id);continue;}
            tools.push({...this.kernel.projectToolSchema(def,true),id,version:this.catalog.metadata(def).version});
          }
          return {tools,notFound,sourceInstructions:this.manager?.instructionsFor(tools.map(d=>sourceOf(d.id))) ?? {}};
        }),
      make('capability_call',
        'Invoke exactly one discovered tool ID with its own arguments object. Optional version comes from capability_describe. Execution uses the original tool, scope, guards, cancellation and result pipeline. A write timeout is never automatically retried.',
        object({id:text('Exact capability ID.'),args:{type:'object',additionalProperties:true},version:text('Optional schema version; stale versions fail before execution.')},['id','args']),
        (args,exec)=>{
          // Only malformed/unavailable requests remain bridge calls. Valid requests
          // are rewritten before native scheduling, preserving media and hooks once.
          this.routeTarget(args,exec);
          throw new RouterInputError('Routing did not complete; retry this request in a new model step');
        }),
    ];
  }
  routeTarget(args,exec) {
    this.assertArgs(this.bridges.get('capability_call').parameters,args);
    const def = this.available(exec).find(d=>d.name===args.id);
    if (!def) throw new RouterInputError('Tool is unavailable in this scope or step. Search again; no tool was executed.');
    if (args.version && args.version !== this.catalog.metadata(def).version) throw new RouterInputError(`SCHEMA_CHANGED: describe ${args.id} again; no tool was executed.`);
    this.assertArgs(def.parameters,args.args);
    return def;
  }
  describe(definitions) {
    const direct=definitions.filter(d=>this.pinned.has(d.name) && !BRIDGES.includes(d.name));
    const schemas=[...direct,...this.bridges.values()].map(d=>this.kernel.projectToolSchema(d,false));
    this.metrics.presented=schemas.length;this.metrics.available=definitions.length;
    this.metrics.schemaBytes=Buffer.byteLength(JSON.stringify(schemas));
    return {schemas,knownNames:[...new Set([...definitions.map(d=>d.name),...BRIDGES])]};
  }
  execute(input) {
    if (this.agent && input.agent !== this.agent) throw new RouterInputError('Wrong agent scope');
    const translate=exec=>{
      if(exec.name!=='capability_call')return exec;
      try {
        const def=this.routeTarget(exec.arguments,exec);
        return {...exec,name:def.name,arguments:exec.arguments.args};
      }catch{return exec;}
    };
    // Keep the ORIGINAL model call blocks in executeToolBatch. Its durable
    // settlement must match assistant/message exactly for DSH log replay.
    // Only pipeline execution identities are translated to the real tool.
    const pipeline={
      executionMode:exec=>this.pipeline.executionMode(translate(exec)),
      prepare:exec=>{
        const actual=translate(exec);
        if(actual.name!==exec.name){
          this.metrics.calls++;
        }else if(exec.name==='capability_call')this.metrics.rejected++;
        return this.pipeline.prepare(actual);
      },
      dispatch:exec=>this.pipeline.dispatch(exec),
      complete:(exec,result)=>this.pipeline.complete(exec,result),
    };
    return this.kernel.executeToolBatch(input,pipeline,()=>this.config.maxParallel);
  }
}
