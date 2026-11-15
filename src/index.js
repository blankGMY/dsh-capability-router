import { projectToolSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { normalizeConfig } from './config.js';
import { CapabilityExecutor } from './executor.js';
import { ManagedServers } from './managed-mcp.js';
import { BRIDGES } from './catalog.js';

export const name='capability-router';
export const inject=['tools','systemPrompt'];
const kernel={projectToolSchema,validateJsonSchemaValue,ToolExecutionPipeline,executeToolBatch};
// Survives plugin reloads without retaining disposed Agent keys. DSH deliberately
// leaves an unloaded executor selection unavailable rather than falling back.
const restored=globalThis[Symbol.for('@gmy/dsh-capability-router/restored')] ??= new WeakMap();

export async function apply(ctx,raw={}) {
  const config=normalizeConfig(raw);
  if (!config.enabled) return;
  const manager=new ManagedServers(ctx,config,{createMcpToolDefinition});
  await manager.initialize();
  ctx.effect(()=>()=>manager.dispose());
  const attached=new Map();
  const attach=agent=>{
    if (attached.has(agent)) return;
    const scoped=agent.ctx.get('tools');
    const previous=scoped.selectExecutor(agent);
    // PTC owns code execution and SDK presentation. Do not silently replace it.
    if (previous.constructor?.name!=='NativeToolExecutor') {
      console.warn(`[capability-router] preserving unsupported executor ${previous.constructor?.name ?? 'unknown'}; this mode is not optimized`);
      return;
    }
    if(ctx.tools.definitions(agent).some(d=>BRIDGES.includes(d.name))) {
      console.warn('[capability-router] reserved bridge name already registered; preserving original executor');return;
    }
    restored.get(agent)?.();restored.delete(agent);
    const executor=new CapabilityExecutor(ctx,config,kernel,{agent,manager});
    const dispose=scoped.setExecutor(executor);
    attached.set(agent,{executor,dispose,previous,scoped});
  };
  ctx.on('agent/created',({agent})=>attach(agent),{global:true});
  ctx.on('agent/disposed',({agent})=>{attached.get(agent)?.executor.dispose();attached.get(agent)?.dispose();attached.delete(agent);restored.get(agent)?.();restored.delete(agent);},{global:true});
  ctx.on('tools/change',()=>{for(const {executor} of attached.values())executor.catalog.invalidate();});
  ctx.inject(['agents'],owner=>{for(const agent of owner.agents.list())attach(agent);});
  ctx.effect(()=>async()=>{
    for(const [agent,{executor,dispose,previous,scoped}] of attached){
      executor.dispose();dispose();restored.set(agent,scoped.setExecutor(previous));
    }
    attached.clear();
  });
  console.log('[capability-router] ready: discovery, schema-on-demand, guarded native dispatch');
}
