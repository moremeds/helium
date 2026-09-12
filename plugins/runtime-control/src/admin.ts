import { readFile } from 'node:fs/promises';
import { parseStrictJson } from '@helium/core';
import { RuntimeControl, type ControlConnection, type ChangeRequest, type VersionRequest } from './index.js';

// Explicit test administrator entry; role authority comes from PostgreSQL, never an actor in JSON.
async function main() {
  const [connectionPath, requestPath] = process.argv.slice(2);
  if (!connectionPath || !requestPath || process.argv.length !== 4) {
    throw new Error('Usage: node plugins/runtime-control/lib/admin.js CONNECTION.json REQUEST.json');
  }
  const connection = parseStrictJson(await readFile(connectionPath, 'utf8')) as ControlConnection;
  if (connection?.user !== 'runtime_control_admin') throw new Error('Test administrator connection required');
  const request = parseStrictJson(await readFile(requestPath, 'utf8')) as { action: string; input: unknown };
  const control = new RuntimeControl(connection);
  let result: unknown;
  switch (request?.action) {
    case 'version': result = await control.createVersion(request.input as VersionRequest); break;
    case 'initialize': result = await control.initialize(request.input as ChangeRequest); break;
    case 'activate': result = await control.activate(request.input as ChangeRequest); break;
    case 'rollback': result = await control.rollback(request.input as ChangeRequest); break;
    default: throw new Error('Expected action: version, initialize, activate, rollback');
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(error => {
  // Do not print config contents, child argv, or database diagnostics.
  process.stderr.write(error instanceof Error && error.message.startsWith('Runtime control')
    ? error.message + '\n' : 'Runtime control administrator request rejected; check local request/config files\n');
  process.exitCode = 1;
});
