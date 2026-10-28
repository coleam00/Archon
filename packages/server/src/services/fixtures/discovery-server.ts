import { startServer } from '../../index';

await startServer({ skipPlatformAdapters: true, port: 0 });
