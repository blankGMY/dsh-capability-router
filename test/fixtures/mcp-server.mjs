import {createInterface} from 'node:readline';
import fs from 'node:fs';
import {join} from 'node:path';
const directory=process.env.FIXTURE_STATE_DIR;
fs.mkdirSync(directory,{recursive:true});fs.appendFileSync(join(directory,'starts'),'start\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
for await(const line of createInterface({input:process.stdin})) {
  const message=JSON.parse(line);if(!('id' in message)) continue;
  const {id,method,params={}}=message;
  if(method==='initialize')send(id,{protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'router-test-fixture',version:'1'},instructions:'Fixture instructions: echo is read-only; write_once changes a local test ledger.'});
  else if(method==='tools/list') {
    const changed=fs.existsSync(join(directory,'changed'));
    const tools=['echo','write_once','wait'].map(name=>({name,description:`Fixture ${name}${changed?' version 2':''}`,inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}));
    send(id,{tools});
  } else if(method==='tools/call') {
    fs.appendFileSync(join(directory,'calls'),params.name+'\n');
    if(params.name==='write_once' && params.arguments.value==='lose-response')process.exit(1);
    if(params.name==='wait')await new Promise(resolve=>setTimeout(resolve,120));
    send(id,{content:[{type:'text',text:params.arguments.value}]});
  } else send(id,{});
}
