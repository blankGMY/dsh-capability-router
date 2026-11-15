import { createHash } from 'node:crypto';

export const BRIDGES = Object.freeze(['capability_search', 'capability_describe', 'capability_call']);
const translations = [
  ['反编译', 'decompile pseudo code'], ['汇编', 'assembly disassemble'], ['函数', 'function'],
  ['交叉引用', 'xref cross reference'], ['字符串', 'string'], ['仓库', 'repository repositories'],
  ['提交', 'commit'], ['分支', 'branch'], ['议题', 'issue'], ['拉取请求', 'pull request'],
  ['记忆', 'memory'], ['画像', 'memory user'], ['日历', 'calendar'], ['定时', 'schedule'],
  ['远程', 'remote rw'], ['截图', 'screenshot capture'], ['调试', 'debug debugger'],
  ['账号', 'user account me'], ['登录', 'authenticated me'], ['版本', 'version'],
  ['状态', 'status'], ['项目', 'project'], ['二进制', 'binary'], ['安卓', 'android'],
];
const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\u0000-\u001f]/g, ' ').trim();
const words = text => normalize(text).replace(/(\p{Script=Han}+)/gu,' $1 ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const stem = word => word.length > 4 ? word.replace(/ies$/, 'y').replace(/s$/, '') : word;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function versionOf(definition) {
  return createHash('sha256').update(JSON.stringify(canonical({name: definition.name, description: definition.description, parameters: definition.parameters, output: definition.output?.schema}))).digest('hex').slice(0, 20);
}
export function sourceOf(name) {
  if (name.startsWith('mcp__')) return name.split('__')[1];
  if (name.startsWith('rw_')) return 'remote';
  for (const prefix of ['memory', 'calendar', 'schedule', 'purge', 'codex', 'subagent']) if (name.startsWith(prefix + '_') || name === prefix) return prefix;
  return 'native';
}
export class Catalog {
  constructor(config) { this.config = config; this.cache = new WeakMap(); }
  invalidate() { this.cache = new WeakMap(); }
  metadata(def) {
    let data = this.cache.get(def);
    if (!data) {
      data = {id: def.name, source: sourceOf(def.name), description: String(def.description ?? ''), version: versionOf(def), aliases: this.config.aliases[def.name] ?? []};
      this.cache.set(def, data);
    }
    return data;
  }
  search(definitions, {query = '', source, cursor = 0, limit = this.config.maxResults} = {}) {
    const q = normalize(query);
    const expanded = q + ' ' + translations.filter(([term]) => q.includes(term)).map(([, english]) => english).join(' ');
    const terms = [...new Set(words(expanded).map(stem))];
    const candidates = definitions.filter(d => !BRIDGES.includes(d.name)).map(def => {
      const data = this.metadata(def);
      if (source && data.source !== source) return null;
      const name = normalize(data.id), desc = normalize(data.description), aliases = data.aliases.map(normalize);
      const fields = new Set(words(name + ' ' + desc).map(stem));
      let score = !q ? 1 : name === q ? 10000 : 0;
      if (q && name.includes(q)) score += 100;
      if (q && aliases.some(a => a && (a.includes(q) || q.includes(a)))) score += 500;
      for (const term of terms) {
        if (words(name).map(stem).includes(term)) score += 25;
        if (fields.has(term)) score += 6;
        if (aliases.some(a => a.includes(term))) score += 15;
      }
      return score ? {...data, score} : null;
    }).filter(Boolean).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id));
    const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const count = Math.min(50, Math.max(1, Number.isSafeInteger(limit) ? limit : this.config.maxResults));
    return {
      matches: candidates.slice(start, start + count).map(({id, source: origin, description, version}) => ({id, source: origin, description: description.replace(/\s+/g,' ').slice(0, 240), version})),
      total: candidates.length, nextCursor: start + count < candidates.length ? start + count : null,
      sources: this.sources(definitions),
    };
  }
  sources(definitions) {
    const counts = new Map();
    for (const d of definitions) if (!BRIDGES.includes(d.name)) counts.set(sourceOf(d.name), (counts.get(sourceOf(d.name)) ?? 0) + 1);
    return [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([source,count])=>({source,count}));
  }
  guidance(definitions) {
    const prefix = 'Installed capabilities remain available on demand. Use capability_search, then capability_describe for exact parameters, then capability_call. Do not infer missing capability from the small direct tool list. Sources: ';
    const sources = this.sources(definitions).map(s=>`${s.source} (${s.count})`);
    let text = prefix;
    for (let i=0;i<sources.length;i++) {
      const next = (i ? ', ' : '') + sources[i];
      if (text.length + next.length + 90 > this.config.sourceBudgetChars) { text += '; additional sources are searchable.'; break; }
      text += next;
    }
    return text;
  }
}
