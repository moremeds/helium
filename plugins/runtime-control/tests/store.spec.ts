import { describe, expect, it } from 'vitest';
import { RuntimeControl, type ControlConnection, type RuntimeScope } from '../src/index.js';

import { startTestDatabase } from './postgres.js';
const suite = process.env.HELIUM_RUNTIME_PG_TEST === '1' ? describe : describe.skip;
suite('isolated real PostgreSQL control store', () => {
  it('enforces ACL, immutable versions, atomic CAS, frozen attempts, failure, rollback and unknown blocking', async () => {
    const db = await startTestDatabase();
    const { admin, runner, sql, runnerConnection: base } = db;
    try {
      const scope:RuntimeScope = {tenant:'fixture',phase:'fixture',kind:'runtime',environment:'test'};
      const payload = { text: "quote '; DROP SCHEMA runtime_control CASCADE; --\n雪", count:2 };
      expect(() => new RuntimeControl({...base,host:'localhost',user:'runtime_control_runner'})).toThrow();
      expect(() => new RuntimeControl({...base,user:'bootstrap' as ControlConnection['user']})).toThrow();
      await expect(runner.createVersion({scope,id:'a',payload})).rejects.toThrow('RC_ADMIN_REQUIRED');
      await expect(sql('SELECT * FROM runtime_control.versions;', 'runtime_control_runner')).rejects.toThrow('permission denied');
      await expect(sql("UPDATE runtime_control.deployments SET revision=99;",'runtime_control_admin')).rejects.toThrow('permission denied');
      await expect(admin.createVersion({scope:{...scope,environment:'production' as 'test'},id:'a',payload})).rejects.toThrow('RC_SCOPE');
      await expect(admin.createVersion({scope,id:'bad',payload:[]})).rejects.toThrow('RC_VERSION');
      const version = await admin.createVersion({scope,id:'a',payload});
      expect(await admin.createVersion({scope,id:'a',payload})).toEqual(version);
      expect(await admin.createVersion({scope,id:'same-content',payload})).toEqual(version);
      await expect(admin.createVersion({scope,id:'a',payload:{count:3}})).rejects.toThrow('RC_VERSION_COLLISION');
      await expect(admin.createVersion({scope:{...scope,phase:'other'},id:'bad',payload,parentId:'a'})).rejects.toThrow('RC_PARENT_SCOPE');
      await admin.createVersion({scope,id:'b',payload:{count:3},parentId:'a'});
      await admin.createVersion({scope,id:'c',payload:{count:1},parentId:'a'});
      const init = {scope,versionId:'a',expectedRevision:0,operationId:'init',approval:'test baseline compatibility reviewed'};
      await expect(runner.initialize(init)).rejects.toThrow('RC_ADMIN_REQUIRED');
      expect(await admin.initialize(init)).toEqual({versionId:'a',revision:1});
      expect(await admin.initialize(init)).toEqual({versionId:'a',revision:1});
      await expect(admin.activate({...init,versionId:1 as unknown as string,operationId:'bad-type'})).rejects.toThrow('RC_OPERATION');
      await expect(admin.initialize({...init,approval:'different'})).rejects.toThrow('RC_IDEMPOTENCY_CONFLICT');
      const snapshot = await runner.resolve(scope,{engineSha:'test-build',inputWorldHash:'fixture-only'});
      expect(snapshot.resolvedPayload).toEqual(payload);
      await runner.startAttempt({attemptId:'first',snapshot,metadata:{dispatchId:'stub-1',costUsd:null}});
      await expect(runner.startAttempt({attemptId:'overlap',snapshot,metadata:{}})).rejects.toThrow('RC_UNRECONCILED_ATTEMPT');
      const changes = await Promise.allSettled([
        admin.activate({...init,versionId:'b',expectedRevision:1,operationId:'to-b'}),
        admin.activate({...init,versionId:'c',expectedRevision:1,operationId:'to-c'}),
      ]);
      expect(changes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
      expect(changes.filter(x=>x.status==='rejected')).toHaveLength(1);
      expect((await runner.inspectAttempt('first')).snapshot).toEqual(snapshot);
      expect((await runner.resolve(scope)).deploymentRevision).toBe(2);
      await runner.finalizeAttempt({attemptId:'first',status:'FAILED',evidence:{error:'stub failure',costUsd:null}});
      await expect(runner.finalizeAttempt({attemptId:'first',status:'SUCCEEDED',evidence:{}})).rejects.toThrow('RC_ALREADY_FINALIZED');
      await expect(runner.startAttempt({attemptId:'stale',snapshot,metadata:{}})).rejects.toThrow('RC_SNAPSHOT');
      expect(await admin.rollback({...init,expectedRevision:2,operationId:'rollback'})).toEqual({versionId:'a',revision:3});
      const restored = await runner.resolve(scope);
      expect(restored.configHash).toBe(snapshot.configHash);
      await expect(runner.startAttempt({attemptId:'tampered',snapshot:{...restored,resolvedPayload:{count:99}},metadata:{}})).rejects.toThrow('integrity');
      await runner.startAttempt({attemptId:'crashed',snapshot:restored,metadata:{dispatchId:'stub-unknown',costUsd:null}});
      expect((await runner.inspectAttempt('crashed')).status).toBe('DISPATCHED');
      await runner.finalizeAttempt({attemptId:'crashed',status:'UNKNOWN',evidence:{costUsd:null,reason:'provider response unknown'}});
      await expect(runner.startAttempt({attemptId:'unsafe-retry',snapshot:restored,metadata:{}})).rejects.toThrow('RC_UNRECONCILED_ATTEMPT');
      expect((await runner.inspectAttempt('crashed')).evidence).toEqual({costUsd:null,reason:'provider response unknown'});
      expect(await sql('SELECT count(*) FROM runtime_control.operations;')).toBe('3');
    } finally {
      await db.stop();
    }
  },60_000);
});
