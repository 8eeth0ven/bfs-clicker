import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SKIP_TEXT_PATTERNS } from './skipwords.js';
export const PROJECT_ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function loadConfig(mode='crawl') {
  const file=process.env.BFS_CONFIG?path.resolve(process.env.BFS_CONFIG):path.join(PROJECT_ROOT,'config.json');
  if(!existsSync(file))throw new Error('缺少配置文件: '+file);
  const cfg=JSON.parse(readFileSync(file,'utf8'));
  cfg._configPath=file;cfg._legacy=true;
  cfg.skipTextPatterns=[...new Set([...DEFAULT_SKIP_TEXT_PATTERNS,...(cfg.skipTextPatterns||[])].map(v=>String(v).toLowerCase()))];
  if(mode==='demo'){
    cfg.startUrl='http://127.0.0.1:3100/';cfg.includeUrlPattern='^http://127\\.0\\.0\\.1:3100/';
    cfg.useProxy=false;cfg.headless=true;cfg.channel=null;cfg.storageState=null;
    cfg.outputDir='output-demo-'+Date.now();cfg.maxStates=50;cfg.maxDepth=3;
    cfg.stabilize={quietMs:80,timeoutMs:800,settleMs:80};
  }
  cfg.outputDir=path.resolve(PROJECT_ROOT,cfg.outputDir||'output');
  if(cfg.storageState)cfg.storageState=path.resolve(PROJECT_ROOT,cfg.storageState);
  if(process.env.MAX_STATES)cfg.maxStates=Number(process.env.MAX_STATES);
  if(process.env.MAX_DEPTH)cfg.maxDepth=Number(process.env.MAX_DEPTH);
  if(process.env.BFS_GOTO_TIMEOUT)cfg.gotoTimeoutMs=Number(process.env.BFS_GOTO_TIMEOUT);
  if(process.env.BFS_HEADLESS!==undefined)cfg.headless=process.env.BFS_HEADLESS!=='0';
  if(process.env.BFS_BROWSER)cfg.browserType=process.env.BFS_BROWSER;
  if(process.env.BFS_PROFILE)cfg.persistentProfile=path.resolve(process.env.BFS_PROFILE);
  if(process.env.BFS_SEED_ROUTES)cfg.seedRoutes=process.env.BFS_SEED_ROUTES.split(',').filter(Boolean);
  if(process.env.BFS_AGREE_KEYWORDS)cfg.agreeKeywords=process.env.BFS_AGREE_KEYWORDS.split(',').filter(Boolean);
  if(process.env.BFS_CONSENT==='off')cfg.autoAgreeConsent=false;
  if(process.env.BFS_SHOT_FORMAT)cfg.shotFormat=process.env.BFS_SHOT_FORMAT;
  cfg.runId=cfg.sessionId=randomUUID()+'_'+new URL(cfg.startUrl).host;
  return cfg;
}
