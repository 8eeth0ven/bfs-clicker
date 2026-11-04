import { watchWorkerParent } from './worker-parent.js';
const releaseParent = watchWorkerParent();
try {
  // Install the parent guard before loading the browser and crawler modules.
  const { main } = await import('./cli.js');
  await main().catch(error => { console.error('[错误] ' + error.message); process.exitCode = 1; });
} finally { releaseParent(); }
