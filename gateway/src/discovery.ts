import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { digest } from './manifest.js';
import { Registry } from './registry.js';
import { LearningStore } from './learning.js';
import { GatewayError, type Endpoint, type GatewayConfig, type Method, type Operation, type SourceSnapshot } from './types.js';

export interface ListInput {
  source?: string; filter?: {endpoint_id?:string;path?:string;method?:Method;provenance?:string;category?:string;kind?:'web'|'apk';extraction_source?:string};
  include_schema?: boolean; limit?: number; cursor?: string;
}
export interface SearchInput { keyword:string;source?:string;include_schema?:boolean;limit?:number;cursor?:string }
interface PageSnapshot {created:number; hash:string; items:any[]; sources:any[]; bytes:number}
interface Redaction { value<T>(v:T):T; catalogValue?<T>(v:T):T }
const normalize = (v:string) => v.normalize('NFKC').toLowerCase();
const words = (v:string): string[] => normalize(v).split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

export class Discovery {
  private readonly snapshots = new Map<string,PageSnapshot>();
  private readonly secret = randomBytes(32);
  private snapshotBytes=0;
  constructor(private readonly registry:Registry, private readonly learning:LearningStore, private readonly config:GatewayConfig, private readonly redactor:Redaction = {value:v=>v}, private readonly ttl=300000, private readonly snapshotBudget={single:16*1024*1024,total:64*1024*1024}) {}
  private redact<T>(value:T):T{return this.redactor.catalogValue?this.redactor.catalogValue(value):this.redactor.value(value);}
  sourceSummary(source:SourceSnapshot):any {
    return {source:source.id,kind:source.kind,revision:source.revision,origins:source.origins,endpoint_count:source.endpoints.length,auth_configured:!!source.binding.credentials,app:source.app || null,resource_uri:`inventory://sources/${encodeURIComponent(source.id)}/manifest.json`};
  }
  endpointSummary(ep:Endpoint, includeSchema:boolean):any {
    const operations:Record<string,any> = {};
    for (const method of ep.methods) {
      const op = ep.operations[method]!;
      const health = this.learning.get(ep.source,ep.id,op);
      operations[method] = {
        method,description:op.description,categories:op.categories,provenance:op.provenance,
        extraction_sources:op.extraction_sources,locations:op.locations,
        allowed:op.allowed,blocked_reason:op.blocked_reason || null,
        parameter_summary:op.parameter_summary,health,
        quality_label:health.state==='http_verified'?'HTTP 已验证':health.state==='not_found_suspected'?'连续未找到，疑似失效':op.provenance.includes('observed')?'已实抓，尚未复验':'未验证',
        ...(includeSchema ? {params_schema:op.params_schema} : {})
      };
    }
    const unresolved=ep.unresolved_candidates.map(candidate=>{
      const {params_schema,...summary}=candidate;return {...summary,...(includeSchema?{params_schema}:{} )};
    });
    return {id:ep.id,source:ep.source,source_revision:ep.source_revision,origin:ep.origin,path:ep.path,methods:ep.methods,operations,unresolved_candidates:unresolved,allowed:ep.methods.some(m=>ep.operations[m]?.allowed)};
  }
  resource(sourceId:string):any {
    const s=this.registry.get(sourceId);
    return this.redact({schema_version:'1.1',...this.sourceSummary(s),endpoints:s.endpoints.map(ep=>this.endpointSummary(ep,true)),warnings:s.warnings});
  }
  list(args:ListInput):any {
    const query={source:args.source || '*',filter:args.filter || {},include_schema:args.include_schema ?? false,limit:args.limit ?? 20};
    this.validatePage(query.limit);
    if (args.cursor) return this.page(args.cursor,digest(['list',query]),query.limit);
    const sources=this.selectSources(query.source);
    const items:any[]=[];
    for (const source of sources) {
      if (query.filter.kind && source.kind!==query.filter.kind) continue;
      for (const ep of source.endpoints) {
        if (query.filter.endpoint_id && ep.id!==query.filter.endpoint_id) continue;
        if (query.filter.path && !normalize(ep.path).includes(normalize(query.filter.path))) continue;
        const variantFilter=!!(query.filter.method || query.filter.provenance || query.filter.category || query.filter.extraction_source);
        const matched=ep.methods.filter(method=>{
          const op=ep.operations[method]!;
          return (!query.filter.method || method===query.filter.method) && (!query.filter.provenance || op.provenance.includes(query.filter.provenance)) && (!query.filter.category || op.categories.includes(query.filter.category)) && (!query.filter.extraction_source || op.extraction_sources.includes(query.filter.extraction_source));
        });
        const unresolvedMatches=!query.filter.method && ep.unresolved_candidates.some(u=>(!query.filter.provenance || u.provenance.includes(query.filter.provenance)) && (!query.filter.extraction_source || u.extraction_sources?.includes(query.filter.extraction_source) || u.extraction_source===query.filter.extraction_source) && (!query.filter.category || u.categories?.includes(query.filter.category)));
        if (variantFilter && !matched.length && !unresolvedMatches) continue;
        items.push({...this.endpointSummary(ep,query.include_schema),kind:source.kind,matched_methods:matched});
      }
    }
    items.sort((a,b)=>a.source.localeCompare(b.source)||a.origin.localeCompare(b.origin)||a.path.localeCompare(b.path)||a.id.localeCompare(b.id));
    return this.newPage(digest(['list',query]),items,sources,query.limit);
  }
  search(args:SearchInput):any {
    const query={source:args.source || '*',keyword:args.keyword.trim(),include_schema:args.include_schema ?? true,limit:args.limit ?? 5};
    this.validatePage(query.limit);
    if (!query.keyword || query.keyword.length>256) throw new GatewayError('PARAMS_INVALID','keyword 必须为 1–256 字符');
    if (args.cursor) return this.page(args.cursor,digest(['search',query]),query.limit);
    const sources=this.selectSources(query.source);
    const docs:{ep:Endpoint;kind:string;path:string;tokens:string[];text:string}[]=[];
    for (const s of sources) for (const ep of s.endpoints) {
      const ops=Object.values(ep.operations) as Operation[];
      const unresolvedText=ep.unresolved_candidates.flatMap(u=>[u.description||'',...(u.parameter_summary||[]).map((p:any)=>p.name),...(u.categories||[]),...(u.locations||[])]);
      const text=[ep.path,...ops.flatMap(op=>[op.description,...op.parameter_summary.map(p=>p.name),...op.categories,...op.locations]),...unresolvedText].join(' ');
      docs.push({ep,kind:s.kind,path:normalize(ep.path),text:normalize(text),tokens:words(text)});
    }
    const terms=[...new Set(words(query.keyword))];
    const q=normalize(query.keyword);
    const average=docs.reduce((sum,d)=>sum+d.tokens.length,0)/Math.max(docs.length,1);
    const frequencies=new Map(terms.map(t=>[t,docs.filter(d=>d.tokens.includes(t)).length]));
    const items=docs.flatMap(d=>{
      let score=d.path===q?100:d.path.startsWith(q)?30:d.path.includes(q)?15:0;
      if(d.text.includes(q))score+=3;
      for(const term of terms){
        const tf=d.tokens.filter(x=>x===term).length;
        if(tf){const df=frequencies.get(term)||0;const idf=Math.log(1+(docs.length-df+0.5)/(df+0.5));score+=idf*(tf*2.2)/(tf+1.2*(0.25+0.75*d.tokens.length/Math.max(average,1)));}
        else if(d.path.includes(term))score+=1;
      }
      // Character bigrams provide bounded fuzzy recall for path spelling and Chinese descriptions.
      if(score===0&&q.length>=3){const grams=new Set(Array.from({length:q.length-1},(_,i)=>q.slice(i,i+2)));const overlap=[...grams].filter(g=>d.text.includes(g)).length/grams.size;if(overlap>=0.6)score=overlap;}
      return score>0?[{...this.endpointSummary(d.ep,query.include_schema),kind:d.kind,score:Math.round(score*1000000)/1000000}]:[];
    }).sort((a,b)=>b.score-a.score||a.source.localeCompare(b.source)||a.id.localeCompare(b.id));
    return this.newPage(digest(['search',query]),items,sources,query.limit);
  }
  private selectSources(source:string):SourceSnapshot[]{return source==='*'?this.registry.all():[this.registry.get(source)];}
  private validatePage(limit:number):void {if(!Number.isInteger(limit)||limit<1||limit>100)throw new GatewayError('PARAMS_INVALID','limit 必须为 1–100');}
  private newPage(hash:string,items:any[],sources:SourceSnapshot[],limit:number):any {
    const now=Date.now();
    for(const [id,s]of this.snapshots)if(now-s.created>this.ttl)this.removeSnapshot(id);
    const cleanItems=this.redact(structuredClone(items)),cleanSources=this.redact(sources.map(s=>this.sourceSummary(s)));
    const bytes=Buffer.byteLength(JSON.stringify({items:cleanItems,sources:cleanSources}),'utf8');
    if(bytes>this.snapshotBudget.single||bytes>this.snapshotBudget.total)throw new GatewayError('CATALOG_SNAPSHOT_TOO_LARGE','查询快照超过内存预算，请缩小source或过滤条件、关闭include_schema');
    while(this.snapshots.size&&(this.snapshots.size>=32||this.snapshotBytes+bytes>this.snapshotBudget.total))this.removeSnapshot(this.snapshots.keys().next().value!);
    const id=randomUUID();
    this.snapshots.set(id,{created:now,hash,items:cleanItems,sources:cleanSources,bytes});this.snapshotBytes+=bytes;
    return this.render(id,0,limit);
  }
  private removeSnapshot(id:string):void {const s=this.snapshots.get(id);if(s){this.snapshotBytes-=s.bytes;this.snapshots.delete(id);}}
  private token(id:string,offset:number):string {
    const body=Buffer.from(JSON.stringify({id,offset})).toString('base64url');
    return body+'.'+createHmac('sha256',this.secret).update(body).digest('base64url');
  }
  private page(cursor:string,hash:string,limit:number):any {
    try{
      const [body,mac,...extra]=cursor.split('.');
      if(!body||!mac||extra.length||cursor.length>1024)throw new Error();
      const expected=createHmac('sha256',this.secret).update(body).digest();const actual=Buffer.from(mac,'base64url');
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();
      const {id,offset}=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
      const s=this.snapshots.get(id);
      if(!s||Date.now()-s.created>this.ttl)throw new GatewayError('CURSOR_EXPIRED','目录快照已过期，请从第一页重取');
      if(s.hash!==hash)throw new GatewayError('CURSOR_MISMATCH','cursor 的查询条件或页大小不一致');
      if(!Number.isInteger(offset)||offset<0||offset>s.items.length)throw new Error();
      return this.render(id,offset,limit);
    }catch(e){if(e instanceof GatewayError)throw e;throw new GatewayError('CURSOR_INVALID','cursor 无效');}
  }
  private render(id:string,offset:number,limit:number):any {
    const s=this.snapshots.get(id)!;const selected:any[]=[];let next=offset;
    if(Buffer.byteLength(JSON.stringify({sources:s.sources,items:[],snapshot_id:id,next_cursor:null,total:s.items.length}),'utf8')>this.config.max_catalog_bytes-256)throw new GatewayError('CATALOG_METADATA_TOO_LARGE','来源摘要超过目录输出预算，请选择单一source');
    for(;next<s.items.length&&selected.length<limit;next++){
      const candidate={sources:s.sources,items:[...selected,s.items[next]],snapshot_id:id,next_cursor:null};
      if(Buffer.byteLength(JSON.stringify(candidate),'utf8')>this.config.max_catalog_bytes-256){
        if(!selected.length)throw new GatewayError('CATALOG_ITEM_TOO_LARGE','单条目录详情超过输出预算，请关闭 include_schema 或读取站点资源');
        break;
      }
      selected.push(s.items[next]);
    }
    return {sources:s.sources,items:selected,snapshot_id:id,next_cursor:next<s.items.length?this.token(id,next):null,total:s.items.length};
  }
}
