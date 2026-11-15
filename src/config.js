export const DEFAULT_PINNED = Object.freeze([
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'read_image',
  'skill', 'web_search', 'web_fetch', 'ask_user_question', 'memory_recall', 'memory_note',
]);

export function normalizeConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Router config must be an object');
  const known = new Set(['enabled', 'pinnedTools', 'aliases', 'maxResults', 'maxParallel', 'sourceBudgetChars', 'servers', 'cacheDir']);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new TypeError(`Unknown router option: ${key}`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  const pinned = raw.pinnedTools ?? DEFAULT_PINNED;
  if (!Array.isArray(pinned) || pinned.some(x => typeof x !== 'string' || !x.trim())) throw new TypeError('pinnedTools must contain nonempty names');
  const positive = (key, fallback, max) => {
    const value = raw[key] ?? fallback;
    if (!Number.isInteger(value) || value < 1 || value > max) throw new RangeError(`${key} must be between 1 and ${max}`);
    return value;
  };
  const aliases = raw.aliases ?? {};
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) throw new TypeError('aliases must be a tool-name map');
  for (const values of Object.values(aliases)) if (!Array.isArray(values) || values.some(x => typeof x !== 'string')) throw new TypeError('aliases must map tool names to string arrays');
  const servers = raw.servers ?? [];
  if (!Array.isArray(servers)) throw new TypeError('servers must be an array');
  const names = new Set();
  for (const server of servers) {
    if (!server || !/^[A-Za-z0-9_-]{1,32}$/.test(server.serverName ?? '')) throw new TypeError('Every managed server needs a stable serverName');
    if (names.has(server.serverName)) throw new TypeError(`Duplicate server: ${server.serverName}`);
    names.add(server.serverName);
    const accepted = new Set(['serverName', 'transport', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'stateless', 'idleTimeoutMs', 'toolCallTimeoutMs', 'connectTimeoutMs']);
    for (const key of Object.keys(server)) if (!accepted.has(key)) throw new TypeError(`Unknown managed-server field: ${key}`);
    if (!['stdio', 'streamable-http'].includes(server.transport)) throw new TypeError('Managed transport must be stdio or streamable-http');
    if (server.transport === 'stdio' && (!server.command || typeof server.command !== 'string')) throw new TypeError('stdio needs command');
    if (server.transport === 'streamable-http' && !/^https?:\/\//.test(server.url ?? '')) throw new TypeError('HTTP transport needs url');
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(x => typeof x !== 'string'))) throw new TypeError('args must be strings');
    for (const key of ['env', 'headers']) if (server[key] !== undefined && (!server[key] || typeof server[key] !== 'object' || Array.isArray(server[key]) || Object.values(server[key]).some(x => typeof x !== 'string'))) throw new TypeError(`${key} must contain string values`);
    for (const key of ['toolCallTimeoutMs', 'connectTimeoutMs']) if (server[key] !== undefined && (!Number.isInteger(server[key]) || server[key] < 1)) throw new TypeError(`${key} must be a positive integer`);
    if (server.stateless !== undefined && typeof server.stateless !== 'boolean') throw new TypeError('stateless must be boolean');
    if (server.idleTimeoutMs !== undefined && (!Number.isInteger(server.idleTimeoutMs) || server.idleTimeoutMs < 0)) throw new TypeError('idleTimeoutMs must be a nonnegative integer');
    if (server.stateless !== true && server.idleTimeoutMs > 0) throw new TypeError('Idle reaping requires stateless: true');
  }
  if (raw.cacheDir !== undefined && typeof raw.cacheDir !== 'string') throw new TypeError('cacheDir must be a path');
  return {
    enabled: raw.enabled !== false, pinnedTools: [...new Set(pinned)], aliases,
    maxResults: positive('maxResults', 5, 50), maxParallel: positive('maxParallel', 4, 32),
    sourceBudgetChars: positive('sourceBudgetChars', 1000, 10000), servers, cacheDir: raw.cacheDir,
  };
}
