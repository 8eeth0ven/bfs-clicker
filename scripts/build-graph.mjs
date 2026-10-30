import { parseArgs } from 'node:util';
import { buildGraphForRun } from '../src/graph-run.js';
const { values } = parseArgs({ options: { run: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
if (values.help) console.log('用法: npm run graph -- --run /path/to/output-run\n仅从已有断点和证据生成流程/调用图，不启动浏览器或重爬目标。');
else if (!values.run) throw new Error('请指定 --run 运行目录');
else console.log(JSON.stringify(await buildGraphForRun(values.run)));
