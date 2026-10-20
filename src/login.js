import { runAsset } from './runner.js';
export function login({ config, log = console.log }) {
  return runAsset({ ...config, authMode: 'manual', headless: false, maxDurationMs: config.loginTimeoutMs || 600000 }, { log, manualLogin: true });
}
