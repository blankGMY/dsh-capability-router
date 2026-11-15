import test from 'node:test';
import assert from 'node:assert/strict';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {lazyValidator} from '../src/lazy-validator.js';

test('large MCP catalogs do not eagerly compile unused output schemas',()=>{
  let compiled=0;const validator=lazyValidator({getValidator(schema){compiled++;return new AjvJsonSchemaValidator().getValidator(schema);}});
  const validators=Array.from({length:300},()=>validator.getValidator({type:'object',properties:{value:{type:'string'}},required:['value']}));
  assert.equal(compiled,0);
  assert.equal(validators[299]({value:'ok'}).valid,true);assert.equal(compiled,1);
  assert.equal(validators[299]({value:42}).valid,false);assert.equal(compiled,1);
});
