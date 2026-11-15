import test from 'node:test';
import assert from 'node:assert/strict';
import {Catalog,versionOf} from '../src/catalog.js';
import {normalizeConfig} from '../src/config.js';
const def=(name,description='fixture capability')=>({name,description,parameters:{type:'object',properties:{}},output:{schema:{type:'object'}}});

test('catalog beyond 255 tools remains searchable, paginated and schema-free',()=>{
  const catalog=new Catalog(normalizeConfig());
  const definitions=Array.from({length:300},(_,i)=>def(`mcp__rea__operation_${i}`));
  const exact=catalog.search(definitions,{query:'mcp__rea__operation_299'});
  assert.equal(exact.matches[0].id,'mcp__rea__operation_299');
  assert.ok(!JSON.stringify(exact).includes('parameters'));
  let cursor=0;const ids=[];
  do{const page=catalog.search(definitions,{query:'',limit:37,cursor});ids.push(...page.matches.map(x=>x.id));cursor=page.nextCursor;}while(cursor!==null);
  assert.equal(new Set(ids).size,300);
});
test('Chinese intent and English plural queries find real IDs',()=>{
  const catalog=new Catalog(normalizeConfig());
  const definitions=[def('mcp__rea__decompile_function','Decompile one function into pseudo code'),def('mcp__github__search_repositories','Search repository by keyword'),def('memory_recall','Search memory'),def('mcp__github__get_me','Get authenticated user')];
  for(const [query,id] of [['请帮我反编译这个程序','mcp__rea__decompile_function'],['查找仓库','mcp__github__search_repositories'],['repositories','mcp__github__search_repositories'],['检索记忆','memory_recall'],['查询当前GitHub登录账号','mcp__github__get_me']])assert.equal(catalog.search(definitions,{query}).matches[0].id,id);
});
test('custom aliases and source filters resolve ambiguity without substituting execution IDs',()=>{
  const catalog=new Catalog(normalizeConfig({aliases:{mcp__rea__inspect:['二进制体检']}}));
  const definitions=[def('mcp__rea__inspect'),def('mcp__github__inspect')];
  assert.equal(catalog.search(definitions,{query:'二进制体检'}).matches[0].id,'mcp__rea__inspect');
  assert.deepEqual(catalog.search(definitions,{query:'inspect',source:'github'}).matches.map(x=>x.id),['mcp__github__inspect']);
  assert.equal(catalog.search(definitions,{query:'nonexistent'}).total,0);
});
test('schema versions change with constraints but not property ordering',()=>{
  const a=def('tool'),b=structuredClone(a);
  b.parameters={properties:{},type:'object'};assert.equal(versionOf(a),versionOf(b));
  b.parameters.required=['path'];assert.notEqual(versionOf(a),versionOf(b));
});
test('new registration and source overview do not require a static allowlist',()=>{
  const catalog=new Catalog(normalizeConfig());const definitions=[def('read')];
  definitions.push(def('mcp__new_plugin__surprise','newly installed capability'));
  assert.equal(catalog.search(definitions,{query:'surprise'}).total,1);
  assert.match(catalog.guidance(definitions),/new_plugin/);
});
test('large source lists respect the overview budget but remain searchable',()=>{
  const catalog=new Catalog(normalizeConfig({sourceBudgetChars:500}));
  const definitions=Array.from({length:100},(_,i)=>def(`mcp__source_${i}__tool`));
  assert.ok(catalog.guidance(definitions).length<=500);
  assert.equal(catalog.search(definitions,{query:'',source:'source_99'}).total,1);
});
test('user pins have no arbitrary count ceiling and unknown options fail visibly',()=>{
  assert.equal(normalizeConfig({pinnedTools:Array.from({length:80},(_,i)=>`tool_${i}`)}).pinnedTools.length,80);
  assert.throws(()=>normalizeConfig({maxResult:5}),/Unknown/);
  assert.throws(()=>normalizeConfig({servers:[{serverName:'demo',transport:'stdio',command:'node',idleTimeoutMs:100}]}),/stateless/);
  assert.throws(()=>normalizeConfig({servers:[{serverName:'../escape',transport:'stdio',command:'node'}]}));
  assert.throws(()=>normalizeConfig({servers:[{serverName:'demo',transport:'stdio',command:'node',env:{TOKEN:12}}]}));
});
