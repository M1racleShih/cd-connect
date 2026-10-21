import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listenHealth } from '../src/server.js';
import { Journal } from '../src/coordinator/store.js';
import { fixture, snapshot } from './support/coordinator-fixture.js';
const quote=s=>`'${s.replaceAll("'", "'\"'\"'")}'`;
async function cli(args,env){
 const p=spawn(process.execPath,['scripts/event-coordinator.js',...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',x=>output+=x);p.stderr.on('data',x=>output+=x);const [code]=await once(p,'exit');return {code,output};
}
test('A13 CLI init persists zero-turn creation and inherited policy; resume conflict stops; status/stop never launch Codex',async t=>{
 const f=fixture(t);const bin=join(f.dir,'bin');mkdirSync(bin);const shim=join(bin,'codex');
 writeFileSync(shim,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('test/support/codex-jsonl.js'))}\n`,{mode:0o700});
 const server=await listenHealth({port:0,token:'b'.repeat(64),readHealth:()=>({...f.config.binding,profile:'desktop'}),tasks:{call:async name=>{if(name==='task_get')return snapshot();throw new Error('unexpected_write');}}});t.after(()=>server.close());
 writeFileSync(join(f.dir,'connection.json'),JSON.stringify({url:server.url,token:'b'.repeat(64)}),{mode:0o600});
 const configFile=join(f.dir,'config.json');writeFileSync(configFile,JSON.stringify({...f.config,cwd:'/tmp'}),{mode:0o600});const target=join(f.dir,'created');
 const env={PATH:`${bin}:${process.env.PATH}`};
 const initialized=await cli(['init',target,configFile,'--create','--exclusive'],env);assert.equal(initialized.code,0,initialized.output);let data=Journal.read(target);assert.equal(data.lifecycle,'ready');assert.equal(data.stats.attempts,0);assert.equal(data.effective.model,'inherited-fixture');
 const resumed=await cli(['run',target],env);assert.equal(resumed.code,1);assert.match(resumed.output,/codex_rpc_minus_32600/);assert.doesNotMatch(resumed.output,/private provider/);
 const status=await cli(['status',target],{PATH:'/nonexistent'});assert.equal(status.code,0);assert.match(status.output,/fixture-thread/);
 const attached=await cli(['init',join(f.dir,'attached'),configFile,'--thread','explicit-thread','--exclusive'],env);assert.equal(attached.code,1);data=Journal.read(join(f.dir,'attached'));assert.equal(data.lifecycle,'uncertain');assert.equal(data.error,'codex_rpc_minus_32600');
 const stop=await cli(['stop',f.dir],{PATH:'/nonexistent'});assert.equal(stop.code,0);assert.match(stop.output,/no_dsh_cancellation/);
});
