import { refreshCompiledInstallManifest } from '../install-manifest';
import { setLogLevel } from '../logger';

setLogLevel('silent');
refreshCompiledInstallManifest(true, process.execPath, 'test');
process.stdout.write('{"ok":true}\n');
