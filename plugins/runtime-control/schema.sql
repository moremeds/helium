-- M1 test database only. Apply once as database owner in an isolated cluster.
BEGIN;
CREATE ROLE runtime_control_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE runtime_control_runner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE SCHEMA runtime_control;
REVOKE ALL ON SCHEMA runtime_control FROM PUBLIC;
GRANT USAGE ON SCHEMA runtime_control TO runtime_control_admin, runtime_control_runner;
CREATE TABLE runtime_control.versions (
  id text PRIMARY KEY, scope jsonb NOT NULL, payload jsonb NOT NULL,
  canonical_payload text NOT NULL, hash text NOT NULL,
  parent_id text REFERENCES runtime_control.versions(id),
  UNIQUE(scope, hash), CHECK (canonical_payload::jsonb = payload),
  CHECK (hash = encode(sha256(convert_to(canonical_payload, 'UTF8')), 'hex'))
);
CREATE TABLE runtime_control.deployments (
  scope jsonb PRIMARY KEY, version_id text NOT NULL REFERENCES runtime_control.versions(id),
  revision integer NOT NULL CHECK(revision > 0), approval text NOT NULL
);
CREATE TABLE runtime_control.operations (
  id text PRIMARY KEY, request jsonb NOT NULL, result jsonb NOT NULL,
  actor text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE runtime_control.attempts (
  id text PRIMARY KEY, scope jsonb NOT NULL, snapshot jsonb NOT NULL, metadata jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('DISPATCHED', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  evidence jsonb, started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz
);

CREATE FUNCTION runtime_control.request(r jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, runtime_control AS $$
DECLARE
  a text := r->>'action'; p jsonb := r->'input'; s jsonb := p->'scope';
  v runtime_control.versions; d runtime_control.deployments; old runtime_control.operations;
  attempt runtime_control.attempts; result jsonb; snap jsonb; key text; rev integer;
BEGIN
  IF session_user NOT IN ('runtime_control_admin', 'runtime_control_runner') THEN
    RAISE EXCEPTION 'RC_ROLE';
  END IF;
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR a IS NULL THEN RAISE EXCEPTION 'RC_INPUT'; END IF;
  IF a IN ('version', 'initialize', 'activate', 'rollback') AND session_user <> 'runtime_control_admin' THEN
    RAISE EXCEPTION 'RC_ADMIN_REQUIRED';
  END IF;
  IF a IN ('start', 'finalize') AND session_user <> 'runtime_control_runner' THEN
    RAISE EXCEPTION 'RC_RUNNER_REQUIRED';
  END IF;
  IF a = 'start' THEN s := p->'snapshot'->'scope'; END IF;
  IF a IN ('version', 'initialize', 'activate', 'rollback', 'resolve', 'start') THEN
    IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR s->>'environment' IS DISTINCT FROM 'test'
      OR (s - ARRAY['tenant','phase','kind','environment']) <> '{}'::jsonb THEN RAISE EXCEPTION 'RC_SCOPE'; END IF;
    FOREACH key IN ARRAY ARRAY['tenant','phase','kind'] LOOP
      IF jsonb_typeof(s->key) IS DISTINCT FROM 'string' OR length(s->>key) NOT BETWEEN 1 AND 128
        THEN RAISE EXCEPTION 'RC_SCOPE'; END IF;
    END LOOP;
  END IF;
  IF a = 'version' THEN
    IF jsonb_typeof(p->'id') IS DISTINCT FROM 'string' OR length(p->>'id') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(p->'payload') IS DISTINCT FROM 'object'
      OR jsonb_typeof(p->'canonicalPayload') IS DISTINCT FROM 'string'
      OR (p->>'canonicalPayload')::jsonb <> p->'payload' THEN RAISE EXCEPTION 'RC_VERSION'; END IF;
    IF p ? 'parentId' AND (jsonb_typeof(p->'parentId') IS DISTINCT FROM 'string'
      OR NOT EXISTS (SELECT 1 FROM runtime_control.versions WHERE id=p->>'parentId' AND scope=s))
      THEN RAISE EXCEPTION 'RC_PARENT_SCOPE'; END IF;
    SELECT * INTO v FROM runtime_control.versions WHERE id=p->>'id';
    IF FOUND THEN
      IF v.scope <> s OR v.canonical_payload <> p->>'canonicalPayload' OR v.parent_id IS DISTINCT FROM p->>'parentId'
        THEN RAISE EXCEPTION 'RC_VERSION_COLLISION'; END IF;
    ELSE
      SELECT * INTO v FROM runtime_control.versions WHERE scope=s
        AND hash=encode(sha256(convert_to(p->>'canonicalPayload','UTF8')),'hex');
      IF FOUND THEN
        IF v.canonical_payload <> p->>'canonicalPayload' OR v.parent_id IS DISTINCT FROM p->>'parentId'
          THEN RAISE EXCEPTION 'RC_VERSION_COLLISION'; END IF;
      ELSE
        INSERT INTO runtime_control.versions VALUES(p->>'id',s,p->'payload',p->>'canonicalPayload',
          encode(sha256(convert_to(p->>'canonicalPayload','UTF8')),'hex'),p->>'parentId') RETURNING * INTO v;
      END IF;
    END IF;
    RETURN jsonb_build_object('id',v.id,'hash',v.hash);
  ELSIF a IN ('initialize', 'activate', 'rollback') THEN
    IF jsonb_typeof(p->'operationId') IS DISTINCT FROM 'string' OR length(p->>'operationId') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(p->'versionId') IS DISTINCT FROM 'string' OR length(p->>'versionId') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(p->'approval') IS DISTINCT FROM 'string' OR length(trim(p->>'approval')) = 0
      OR jsonb_typeof(p->'expectedRevision') IS DISTINCT FROM 'number'
      OR (p->>'expectedRevision') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'RC_OPERATION'; END IF;
    -- ponytail: one lock serializes this local single-worker store; partition only if M3 needs concurrency.
    LOCK TABLE runtime_control.deployments IN EXCLUSIVE MODE;
    SELECT * INTO old FROM runtime_control.operations WHERE id=p->>'operationId';
    IF FOUND THEN
      IF old.request <> r THEN RAISE EXCEPTION 'RC_IDEMPOTENCY_CONFLICT'; END IF;
      RETURN old.result;
    END IF;
    SELECT * INTO v FROM runtime_control.versions WHERE id=p->>'versionId' AND scope=s;
    IF NOT FOUND THEN RAISE EXCEPTION 'RC_VERSION_SCOPE'; END IF;
    SELECT * INTO d FROM runtime_control.deployments WHERE scope=s;
    rev := (p->>'expectedRevision')::integer;
    IF a = 'initialize' THEN
      IF FOUND OR rev <> 0 THEN RAISE EXCEPTION 'RC_CAS_CONFLICT'; END IF;
      INSERT INTO runtime_control.deployments VALUES(s,v.id,1,p->>'approval');
    ELSE
      IF NOT FOUND OR d.revision <> rev THEN RAISE EXCEPTION 'RC_CAS_CONFLICT'; END IF;
      IF a = 'rollback' AND NOT EXISTS (
        SELECT 1 FROM runtime_control.operations op WHERE op.request->'input'->'scope'=s AND op.result->>'versionId'=v.id
      ) THEN RAISE EXCEPTION 'RC_ROLLBACK_TARGET'; END IF;
      UPDATE runtime_control.deployments SET version_id=v.id,revision=revision+1,approval=p->>'approval' WHERE scope=s;
    END IF;
    result := jsonb_build_object('versionId',v.id,'revision',rev+1);
    INSERT INTO runtime_control.operations(id,request,result,actor) VALUES(p->>'operationId',r,result,session_user);
    RETURN result;
  ELSIF a IN ('resolve', 'start') THEN
    IF a='start' THEN LOCK TABLE runtime_control.deployments IN EXCLUSIVE MODE; END IF;
    SELECT * INTO d FROM runtime_control.deployments WHERE scope=s;
    IF NOT FOUND THEN RAISE EXCEPTION 'RC_MISSING_DEPLOYMENT'; END IF;
    SELECT * INTO v FROM runtime_control.versions WHERE id=d.version_id AND scope=s;
    IF NOT FOUND OR v.hash <> encode(sha256(convert_to(v.canonical_payload,'UTF8')),'hex')
      OR v.canonical_payload::jsonb <> v.payload THEN RAISE EXCEPTION 'RC_INTEGRITY'; END IF;
    result := jsonb_build_object('scope',s,'configVersionId',v.id,'configHash',v.hash,
      'deploymentRevision',d.revision,'configurationApprovalId',d.approval,'resolvedPayload',v.payload);
    IF a='resolve' THEN RETURN result || jsonb_build_object('resolvedAt',clock_timestamp()); END IF;
    snap := p->'snapshot';
    IF jsonb_typeof(p->'attemptId') IS DISTINCT FROM 'string' OR length(p->>'attemptId') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(p->'metadata') IS DISTINCT FROM 'object'
      OR jsonb_typeof(snap->'metadata') IS DISTINCT FROM 'object'
      OR jsonb_typeof(snap->'resolvedAt') IS DISTINCT FROM 'string'
      OR NOT snap @> result
      OR jsonb_typeof(p->'canonicalSnapshot') IS DISTINCT FROM 'string'
      OR (p->>'canonicalSnapshot')::jsonb <> (snap-'effectiveSnapshotHash')
      OR snap->>'effectiveSnapshotHash' IS DISTINCT FROM encode(sha256(convert_to(p->>'canonicalSnapshot','UTF8')),'hex')
      THEN RAISE EXCEPTION 'RC_SNAPSHOT'; END IF;
    IF EXISTS(SELECT 1 FROM runtime_control.attempts WHERE status IN ('DISPATCHED','UNKNOWN'))
      THEN RAISE EXCEPTION 'RC_UNRECONCILED_ATTEMPT'; END IF;
    INSERT INTO runtime_control.attempts(id,scope,snapshot,metadata,status)
      VALUES(p->>'attemptId',s,snap,p->'metadata','DISPATCHED');
    RETURN jsonb_build_object('attemptId',p->>'attemptId','status','DISPATCHED');
  ELSIF a IN ('finalize', 'inspect') THEN
    IF jsonb_typeof(p->'attemptId') IS DISTINCT FROM 'string' OR length(p->>'attemptId') NOT BETWEEN 1 AND 128
      THEN RAISE EXCEPTION 'RC_ATTEMPT'; END IF;
    SELECT * INTO attempt FROM runtime_control.attempts WHERE id=p->>'attemptId' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RC_MISSING_ATTEMPT'; END IF;
    IF a='inspect' THEN RETURN to_jsonb(attempt); END IF;
    IF p->>'status' IS NULL OR p->>'status' NOT IN ('SUCCEEDED','FAILED','UNKNOWN')
      OR jsonb_typeof(p->'evidence') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RC_FINALIZE'; END IF;
    IF attempt.status <> 'DISPATCHED' THEN RAISE EXCEPTION 'RC_ALREADY_FINALIZED'; END IF;
    UPDATE runtime_control.attempts SET status=p->>'status',evidence=p->'evidence',finished_at=clock_timestamp()
      WHERE id=attempt.id;
    RETURN jsonb_build_object('attemptId',attempt.id,'status',p->>'status');
  END IF;
  RAISE EXCEPTION 'RC_ACTION';
END;
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA runtime_control FROM PUBLIC, runtime_control_admin, runtime_control_runner;
REVOKE ALL ON FUNCTION runtime_control.request(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime_control.request(jsonb) TO runtime_control_admin,runtime_control_runner;
COMMIT;
