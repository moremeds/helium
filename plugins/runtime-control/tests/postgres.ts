import { mkdtemp, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { RuntimeControl, type ControlConnection } from '../src/index.js';
const exec = promisify(execFile);

/** Always a new scratch cluster: never reads normal database connection env. */
export async function startTestDatabase() {
  const bin = process.env.HELIUM_RUNTIME_PG_BIN ?? '/opt/homebrew/opt/postgresql@15/bin';
  const scratch = await mkdtemp('/tmp/helium-runtime-');
  const data = join(scratch, 'data');
  const env = { PATH: process.env.PATH, LANG: 'C', HOME: scratch, PGPASSFILE: '/dev/null', PGSERVICEFILE: '/dev/null' };
  const ownerEnv = { ...env, PGHOST: scratch, PGPORT: '55432', PGDATABASE: 'runtime_control_test', PGUSER: 'bootstrap' };
  async function sql(statement: string, role = 'bootstrap'): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(join(bin, 'psql'), ['-XwqAt', '-v', 'ON_ERROR_STOP=1'], {
        env: { ...ownerEnv, PGUSER: role }, stdio: ['pipe','pipe','pipe'],
      });
      let out=''; let err='';
      child.stdout.on('data', value => { out += value; });
      child.stderr.on('data', value => { err += value; });
      child.once('error', reject);
      child.once('close', code => code===0 ? resolve(out.trim()) : reject(new Error(err)));
      child.stdin.end(statement);
    });
  }
  let running = false;
  async function stop() {
    if (running) {
      await exec(join(bin,'pg_ctl'),['-D',data,'-m','fast','-w','stop'],{env});
      running = false;
    }
    console.info(`Runtime PostgreSQL test artifacts: ${scratch}`);
  }
  try {
    await exec(join(bin, 'initdb'), ['-D', data, '-U', 'bootstrap', '-A', 'trust', '--no-locale'], { env });
    await exec(join(bin, 'pg_ctl'), ['-D', data, '-l', join(scratch,'postgres.log'), '-o', `-k ${scratch} -p 55432 -c listen_addresses=''`, '-w', 'start'], { env });
    running = true;
    await exec(join(bin,'createdb'), ['runtime_control_test'], { env: { ...ownerEnv, PGDATABASE: 'postgres' } });
    await sql(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
    const base = { host:scratch,port:55432,database:'runtime_control_test',psqlPath:join(bin,'psql') };
    const adminConnection: ControlConnection = {...base,user:'runtime_control_admin'};
    const runnerConnection: ControlConnection = {...base,user:'runtime_control_runner'};
    return { adminConnection, runnerConnection, admin:new RuntimeControl(adminConnection),
      runner:new RuntimeControl(runnerConnection), sql, scratch, stop };
  } catch(error) { await stop(); throw error; }
}
