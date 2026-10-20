import { main } from './cli.js';
await main().catch(error => { console.error('[错误] ' + error.message); process.exitCode = 1; });
