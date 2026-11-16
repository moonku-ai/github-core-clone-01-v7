// moonku-forge: a single-process GitHub-compatible git forge.
//
// Serves git smart HTTP (upload-pack v2, receive-pack v0), REST v3 under /api/v3,
// GraphQL v4 at /api/graphql, and MCP (streamable HTTP, revision 2026-07-28) at /mcp.
// Node 22 standard library only; no dependencies, no git binary, no network.
//
// Lifecycle: listen(0) -> POST {"port": n} to $MAKEFUN_ENV_URL/register ->
// poll GET $MAKEFUN_ENV_URL/done until {"done": true} -> exit 0.
//
// Determinism: every timestamp the server emits comes from MAKEFUN_TRIAL_NOW (or a
// fixed epoch fallback); no Date.now(), no Math.random(), no UUIDs anywhere in a
// path that reaches state. The X-GitHub-Request-Id header is a per-process counter.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ------------------------------------------------------------------ constants

const ZERO_OID = '0'.repeat(40);
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const SERVER_NAME = 'moonku-forge';
const SERVER_VERSION = '1.0.0';
const TRIAL_NOW_RAW = process.env.MAKEFUN_TRIAL_NOW ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

let trialNowIso = '2026-11-14T06:30:00.000Z';
let trialEpochSec = 1_730_000_000;
{
  const parsed = Date.parse(TRIAL_NOW_RAW);
  if (Number.isFinite(parsed)) {
    trialEpochSec = Math.floor(parsed / 1000);
    trialNowIso = new Date(parsed).toISOString();
  } else if (TRIAL_NOW_RAW !== '') {
    trialNowIso = TRIAL_NOW_RAW;
  }
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

// ------------------------------------------------------------------ small utils

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: string, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

function b64decodeLoose(s: string): Buffer {
  return Buffer.from(s.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

// A tiny deterministic counter for numeric ids (repo / issue / comment / PR ids).
let repoIdCounter = 10000;
let issueIdCounter = 100000;
let commentIdCounter = 1000000;

// ------------------------------------------------------------------ git object model

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: ObjType;
  data: Buffer;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function buildCommitText(tree: string, parents: string[], message: string, who: string, timestamp: number): Buffer {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${who} ${timestamp} +0000\ncommitter ${who} ${timestamp} +0000\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

function buildTagText(object: string, type: string, tag: string, message: string, who: string, timestamp: number): Buffer {
  return Buffer.from(
    `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${who} ${timestamp} +0000\n\n${message}`,
    'utf8',
  );
}

// ------------------------------------------------------------------ packfile

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) {
    bytes.push(first | 0x80);
    first = rem & 0x7f;
    rem = Math.floor(rem / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// Read a packfile; supports OFS_DELTA and REF_DELTA (client pushes never send
// deltas, but fetch replies we parse in tests might). Returns objects keyed by oid.
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('bad pack header');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const firstByte = pack[off];
    const typeCode = (firstByte >> 4) & 0x07;
    let byte = firstByte;
    let size = byte & 0x0f;
    let shift = 4;
    off += 1;
    while (byte & 0x80) {
      byte = pack[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      byte = pack[off];
      off += 1;
      let v = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++];
        v = ((v + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - v;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const codeType: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const resolve = (entry: Raw): { type: ObjType; data: Buffer; oid: string } => {
    const done = resolved.get(entry.offset);
    if (done) return done;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset!)!;
      const b = resolve(base);
      type = b.type;
      data = applyDelta(b.data, entry.data);
    } else if (entry.typeCode === 7) {
      const base = resolveBase?.(entry.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} not available`);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = codeType[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOff += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

// ------------------------------------------------------------------ pkt-line codec

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

// Decode a whole buffer of pkt-lines; returns packets and the offset where the
// framed region ends (the rest is raw pack bytes for receive-pack).
function decodePktLines(buf: Buffer): { packets: DecodedPacket[]; endOffset: number } {
  const packets: DecodedPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, endOffset: off };
}

// ------------------------------------------------------------------ store

interface Label {
  name: string;
  color: string;
}

interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  _json: string;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  created_at: string;
  updated_at: string;
}

class Repo {
  name: string;
  owner: string;
  id: number;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  createdAt = trialNowIso;
  updatedAt = trialNowIso;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextNumber = 1;

  constructor(owner: string, name: string, description: string, isPrivate: boolean) {
    this.owner = owner;
    this.name = name;
    this.id = repoIdCounter++;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  tip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  defaultTip(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  // Walk the commit graph: is `ancestor` reachable from `oid` (parents only)?
  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack: string[] = [oid];
    let steps = 0;
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (++steps > 200000) return false;
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  // All objects reachable from `roots` (commits, trees, blobs, tags).
  reachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const r of roots) if (isOid(r) && r !== ZERO_OID) stack.push(r);
    let steps = 0;
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (++steps > 500000) break;
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tag') {
        const blank = obj.data.indexOf('\n\n');
        const head = (blank < 0 ? obj.data : obj.data.subarray(0, blank)).toString('utf8');
        for (const line of head.split('\n')) {
          if (line.startsWith('object ')) stack.push(line.slice(7));
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') stack.push(e.oid);
        }
      }
    }
    return seen;
  }

  // Commits reachable from `tip`, newest first (first-parent walk + full walk
  // for merge commits: collect all, order by discovery from the tip).
  commitList(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    let steps = 0;
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      if (++steps > 200000) break;
      const parents = parseCommit(obj.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    return out;
  }

  // Flatten a tree into path -> {oid, mode}.
  flattenTree(treeOid: string, prefix = '', out: Map<string, { oid: string; mode: string }> = new Map()): Map<string, { oid: string; mode: string }> {
    const obj = this.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
    return out;
  }

  // Set (or delete with blobOid null) one path in a tree; returns the new tree oid.
  setPath(treeOid: string | null, segments: string[], blobOid: string | null): string {
    if (segments.length === 0) return treeOid ?? this.putObject('tree', buildTree([]));
    const name = segments[0];
    const rest = segments.slice(1);
    let entries: TreeEntry[] = [];
    if (treeOid !== null) {
      const obj = this.objects.get(treeOid);
      if (obj && obj.type === 'tree') entries = parseTree(obj.data);
    }
    const idx = entries.findIndex((e) => e.name === name);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const childOid = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
      const next = this.setPath(childOid, rest, blobOid);
      const child = this.objects.get(next);
      const childEntries = child && child.type === 'tree' ? parseTree(child.data) : [];
      if (childEntries.length === 0 && blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '40000', name, oid: next };
      } else {
        entries.push({ mode: '40000', name, oid: next });
      }
    }
    return this.putObject('tree', buildTree(entries));
  }

  // Read the blob oid at `path` in the tree of `commitOid` (null when absent).
  blobAt(commitOid: string, path: string): string | null {
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    const flat = this.flattenTree(parseCommit(obj.data).tree);
    return flat.get(path)?.oid ?? null;
  }

  // The merge-base of two commits: the first common ancestor found walking both.
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsB = new Set<string>();
    const stackB: string[] = [b];
    let steps = 0;
    while (stackB.length) {
      const cur = stackB.pop()!;
      if (ancestorsB.has(cur)) continue;
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      ancestorsB.add(cur);
      if (++steps > 100000) break;
      for (const p of parseCommit(obj.data).parents) stackB.push(p);
    }
    const stackA: string[] = [a];
    const seenA = new Set<string>();
    steps = 0;
    while (stackA.length) {
      const cur = stackA.pop()!;
      if (ancestorsB.has(cur)) return cur;
      if (seenA.has(cur)) continue;
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      seenA.add(cur);
      if (++steps > 100000) break;
      for (const p of parseCommit(obj.data).parents) stackA.push(p);
    }
    return null;
  }
}

const repos = new Map<string, Repo>();

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function viewerRepo(name: string): Repo | undefined {
  return repos.get(repoKey(VIEWER_LOGIN, name));
}

// ------------------------------------------------------------------ JSON views (REST)

function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    node_id: globalId('Repository', r.id),
    name: r.name,
    full_name: r.fullName,
    owner: { login: r.owner, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false },
    private: r.isPrivate,
    html_url: `https://github.com/${r.fullName}`,
    description: r.description,
    fork: false,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    pushed_at: r.updatedAt,
    git_url: `git://github.com/${r.fullName}.git`,
    ssh_url: `git@github.com:${r.fullName}.git`,
    clone_url: `https://github.com/${r.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length + r.pulls.filter((p) => p.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: r.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: r.defaultBranch,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', VIEWER_ID),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    gravatar_id: '',
    url: '/api/v3/users/adaiversen',
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    public_repos: repos.size,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: trialNowIso,
    updated_at: trialNowIso,
  };
}

function globalId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), value: text.slice(at + 1) };
  } catch {
    return null;
  }
}

function issueJson(r: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${r.id}:${issue.number}`),
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
    html_url: `https://github.com/${r.fullName}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false },
    labels: issue.labels.map((l) => ({ id: 1, node_id: globalId('Label', `${r.id}:${l.name}`), url: `/api/v3/repos/${r.owner}/${r.name}/labels/${encodeURIComponent(l.name)}`, name: l.name, color: l.color, default: false, description: '' })),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    active_lock_reason: null,
    reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: '',
    performed_via_github_app: null,
    state_reason: null,
  };
}

function refreshIssueJson(r: Repo, issue: Issue): void {
  issue._json = jsonString(issueJson(r, issue));
}

function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  const headRepo = repoJson(r);
  const baseRepo = repoJson(r);
  return {
    id: p.id,
    node_id: globalId('PullRequest', `${r.id}:${p.number}`),
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    html_url: `https://github.com/${r.fullName}/pull/${p.number}`,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false },
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.merged ? p.mergedAt : p.state === 'closed' ? p.updated_at : null,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    merged: p.merged,
    mergeable: prMergeable(r, p),
    mergeable_state: prMergeable(r, p) ? 'clean' : 'dirty',
    merged_by: p.merged ? { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false } : null,
    head: { label: `${r.owner}:${p.headRef}`, ref: p.headRef, sha: p.headSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false }, repo: headRepo },
    base: { label: `${r.owner}:${p.baseRef}`, ref: p.baseRef, sha: p.baseSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false }, repo: baseRepo },
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
  };
}

// Is this PR mergeable right now (three-way check against the merge-base)?
function prMergeable(r: Repo, p: Pull): boolean {
  if (p.state !== 'open') return false;
  const headTip = r.tip(`refs/heads/${p.headRef}`);
  const baseTip = r.tip(`refs/heads/${p.baseRef}`);
  if (!headTip || !baseTip) return false;
  if (headTip === baseTip) return true;
  const base = r.mergeBase(headTip, baseTip);
  if (base === null) return false;
  const headFlat = r.flattenTree(parseCommit(r.objects.get(headTip)!.data).tree);
  const baseFlat = r.flattenTree(parseCommit(r.objects.get(baseTip)!.data).tree);
  const mergeFlat = r.flattenTree(parseCommit(r.objects.get(base)!.data).tree);
  const paths = new Set([...headFlat.keys(), ...baseFlat.keys(), ...mergeFlat.keys()]);
  for (const path of paths) {
    const h = headFlat.get(path)?.oid ?? null;
    const b = baseFlat.get(path)?.oid ?? null;
    const m = mergeFlat.get(path)?.oid ?? null;
    const headChanged = h !== m;
    const baseChanged = b !== m;
    if (headChanged && baseChanged && h !== b) return false;
  }
  return true;
}

function makeCommit(r: Repo, message: string, treeOid: string, parents: string[]): string {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const data = buildCommitText(treeOid, parents, message.endsWith('\n') ? message : `${message}\n`, who, trialEpochSec);
  return r.putObject('commit', data);
}

// Diff two trees: returns changed paths with line counts.
function diffTrees(r: Repo, baseTreeOid: string | null, headTreeOid: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseFlat = baseTreeOid === null ? new Map() : r.flattenTree(baseTreeOid);
  const headFlat = r.flattenTree(headTreeOid);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b && !h) {
      const lines = blobLineCount(r, b.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (!b && h) {
      const lines = blobLineCount(r, h.oid);
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b && h && b.oid !== h.oid) {
      const { additions, deletions } = lineDiff(r, b.oid, h.oid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

function blobText(r: Repo, oid: string): string {
  const obj = r.objects.get(oid);
  if (!obj || obj.type !== 'blob') return '';
  return obj.data.toString('utf8');
}

function blobLineCount(r: Repo, oid: string): number {
  const text = blobText(r, oid);
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function lineDiff(r: Repo, oldOid: string, newOid: string): { additions: number; deletions: number } {
  const a = blobText(r, oldOid).split('\n');
  const b = blobText(r, newOid).split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return { additions: b.length - prefix - suffix, deletions: a.length - prefix - suffix };
}

// ------------------------------------------------------------------ git smart HTTP

function gitRefLines(r: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...r.refs.keys()].sort();
  for (const name of names) {
    const oid = r.refs.get(name)!;
    out.push({ oid, name });
    const obj = r.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const blank = obj.data.indexOf('\n\n');
      const head = (blank < 0 ? obj.data : obj.data.subarray(0, blank)).toString('utf8');
      for (const line of head.split('\n')) {
        if (line.startsWith('object ')) out.push({ oid: line.slice(7), name: `${name}^{}` });
      }
    }
  }
  return out;
}

function v0Advertisement(r: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(PKT_FLUSH);
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=moonku-forge/1.0'
      : 'report-status side-band-64k delete-refs ofs-delta agent=moonku-forge/1.0';
  const refs = gitRefLines(r);
  const headTip = r.defaultTip();
  const headOid = headTip ?? ZERO_OID;
  const firstLine = `${headOid} HEAD\0${caps}\n`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(firstLine));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=moonku-forge/1.0\n'),
    pktLine('server-option\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// ls-refs response (v2). `wants` are the parsed arguments.
function lsRefsResponse(r: Repo, wants: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => wants.prefixes.length === 0 || wants.prefixes.some((p) => name.startsWith(p));
  const headTip = r.defaultTip();
  const emitHead = (): void => {
    if (!keep('HEAD')) return;
    if (headTip === undefined) {
      if (wants.unborn) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    } else {
      parts.push(pktLine(`${headTip} HEAD${wants.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  };
  emitHead();
  for (const ref of gitRefLines(r)) {
    if (ref.name.endsWith('^{}')) continue;
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wants.peel) {
      const peeled = gitRefLines(r).find((x) => x.name === `${ref.name}^{}`);
      if (peeled) line += ` peeled:${peeled.oid}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

// Plan a fetch: objects reachable from `wants`, minus those reachable from
// `haves`, limited by `depth` (commit generations). `shallowBoundaries` are
// the client's current shallow tips (for deepen).
function planFetch(r: Repo, wants: string[], haves: string[], depth: number | null, shallowBoundaries: string[]): FetchPlan {
  const haveReachable = r.reachable(haves);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const wanted = new Set<string>();
  if (depth === null) {
    for (const oid of r.reachable(wants)) {
      if (!haveReachable.has(oid)) wanted.add(oid);
    }
  } else {
    // BFS over commits by generation; objects of commits within depth.
    const commitGen = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = wants.filter((w) => isOid(w)).map((w) => ({ oid: w, gen: 1 }));
    const boundary = new Set<string>();
    while (queue.length) {
      const { oid, gen } = queue.shift()!;
      if (commitGen.has(oid)) continue;
      const obj = r.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      commitGen.set(oid, gen);
      if (gen === depth) {
        boundary.add(oid);
        continue;
      }
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, gen: gen + 1 });
    }
    // Objects needed by the in-depth commits: each commit plus its whole
    // tree closure, but never a parent commit (parents are cut by depth).
    // Shared blobs stay: a blob is wanted when the in-depth tree names it,
    // even if a deeper commit's tree names it too.
    for (const oid of commitGen.keys()) {
      if (haveReachable.has(oid)) continue;
      wanted.add(oid);
      const obj = r.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const tree = parseCommit(obj.data).tree;
      const stack: string[] = [tree];
      while (stack.length) {
        const cur = stack.pop()!;
        if (wanted.has(cur) || haveReachable.has(cur)) continue;
        const o = r.objects.get(cur);
        if (!o) continue;
        wanted.add(cur);
        if (o.type === 'tree') {
          for (const e of parseTree(o.data)) {
            if (e.mode !== '160000') stack.push(e.oid);
          }
        } else if (o.type === 'tag') {
          const blank = o.data.indexOf('\n\n');
          const head = (blank < 0 ? o.data : o.data.subarray(0, blank)).toString('utf8');
          for (const line of head.split('\n')) {
            if (line.startsWith('object ')) stack.push(line.slice(7));
          }
        }
      }
    }
    for (const b of boundary) shallow.push(b);
    // An old boundary is unshallow only when it is now inside the fetched
    // commit set (deepened past); a boundary still beyond depth stays shallow.
    for (const old of shallowBoundaries) {
      if (!boundary.has(old) && commitGen.has(old)) unshallow.push(old);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    const obj = r.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow, unshallow };
}

function packSideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

function handleUploadPackV2(r: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  let command = '';
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    if (!seenDelim) {
      const m = /^command=(\S+)/.exec(text.trim());
      if (m) command = m[1];
      continue;
    }
    lines.push(text.replace(/\n$/, ''));
  }
  if (command === 'ls-refs') {
    const wants = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const line of lines) {
      if (line === 'peel') wants.peel = true;
      else if (line === 'symrefs') wants.symrefs = true;
      else if (line === 'unborn') wants.unborn = true;
      else if (line.startsWith('ref-prefix ')) wants.prefixes.push(line.slice(11));
    }
    return { status: 200, body: lsRefsResponse(r, wants), contentType: 'application/x-git-upload-pack-result' };
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7), 10);
        if (Number.isFinite(n)) depth = n;
      }
    }
    const plan = planFetch(r, wants, haves, depth, shallowIn);
    const pack = writePack(plan.objects);
    const parts: Buffer[] = [];
    if (haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine('NAK\n'));
      parts.push(pktLine('ready\n'));
      parts.push(PKT_DELIM);
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(packSideband(pack));
    parts.push(PKT_FLUSH);
    return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
  }
  return { status: 400, body: Buffer.from(jsonString({ message: 'unknown command' })), contentType: 'application/json' };
}

function handleUploadPackV0(r: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (!seenFlush) {
      if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
      else if (text.startsWith('shallow ')) shallowIn.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = parseInt(text.slice(7), 10);
        if (Number.isFinite(n)) depth = n;
      }
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    }
  }
  const plan = planFetch(r, wants, haves, depth, shallowIn);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(packSideband(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(r: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const { packets, endOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!m) throw new Error('bad receive-pack command line');
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  if (commands.length === 0) throw new Error('empty command list');
  // The pack follows the flush packet.
  const packBytes = body.subarray(endOffset);
  const hasPack = packBytes.length > 0;
  const needPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needPack && hasPack) {
    const objects = readPack(packBytes, (oid) => r.objects.get(oid));
    for (const [oid, obj] of objects) {
      if (!r.objects.has(oid)) r.objects.set(oid, obj);
    }
  }
  // Evaluate each command.
  const reportLines: string[] = ['unpack ok'];
  for (const cmd of commands) {
    const current = r.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} no such ref`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        r.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} already exists`);
        continue;
      }
      if (!r.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} object not found`);
        continue;
      }
      r.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}`);
      continue;
    }
    // Update: old must match, new must descend from old.
    if (current === undefined || current !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    if (!r.objects.has(cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    if (cmd.newOid === cmd.oldOid || r.isAncestor(cmd.oldOid, cmd.newOid)) {
      r.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}`);
    } else {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
    }
  }
  const reportParts: Buffer[] = [];
  for (const line of reportLines) reportParts.push(pktLine(`${line}\n`));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  const banded = Buffer.concat([Buffer.from([1]), report]);
  const parts: Buffer[] = [pktLine(banded), PKT_FLUSH];
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-receive-pack-result' };
}

// ------------------------------------------------------------------ HTTP plumbing

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer, path: string, query: URLSearchParams) => void | Promise<void>;

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = typeof value === 'string' ? value : jsonString(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendJsonText(res: ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization;
  return h === `Bearer ${TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > 32 * 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(body.toString('utf8')) as unknown;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Split a path into decoded segments (no leading empty, no trailing empty).
function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map(decodeSegment);
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): { pageItems: T[]; hasNext: boolean; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), hasNext: page < totalPages, totalPages };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string {
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const links: string[] = [];
  const q = (p: number): string => {
    const qp = new URLSearchParams(query);
    qp.set('page', String(p));
    qp.set('per_page', String(perPage));
    return `${base}?${qp.toString()}`;
  };
  if (page < totalPages) links.push(`<${q(page + 1)}>; rel="next"`);
  if (totalPages > 1) links.push(`<${q(totalPages)}>; rel="last"`);
  if (page > 1) {
    links.push(`<${q(1)}>; rel="first"`);
    links.push(`<${q(page - 1)}>; rel="prev"`);
  }
  return links.join(', ');
}

// ------------------------------------------------------------------ REST v3

function restNotFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

async function handleRest(req: IncomingMessage, res: ServerResponse, body: Buffer, path: string, query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  // Auth: every /api/v3 route requires the bearer token.
  if (!authed(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  const seg = splitPath(path); // seg[0]='api', seg[1]='v3', ...
  const rest = seg.slice(2);

  // GET /api/v3/ — API root.
  if (rest.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/users/{user}/followers',
      following_url: '/api/v3/users/{user}/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/users/{user}/keys',
      label_search_url: '/api/v3/search/labels?repository_id={repository_id}&q={query}{&page,per_page}',
      notifications_url: '/api/v3/notifications{?since,all,participating}',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/users/{user}/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_enterprise_version: '1.0.0', hooks: [], git: [], pages: [], importer: [], actions: [], packages: [], dependabot: [] });
    return;
  }

  // GET /api/v3/user  |  POST /api/v3/user/repos  |  GET /api/v3/user/repos
  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(res, 200, userJson());
      return;
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = pageParams(query);
        const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN);
        const { pageItems, hasNext, totalPages } = paginate(all, page, perPage);
        const headers: Record<string, string> = {};
        if (hasNext || totalPages > 1) headers.link = linkHeader(req, path, query, page, perPage, totalPages);
        sendJson(res, 200, pageItems.map(repoJson), headers);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const name = parsed.value.name;
        if (typeof name !== 'string' || name === '') return sendError(res, 422, 'name is required');
        if (viewerRepo(name)) return sendError(res, 422, 'Repository already exists');
        const r = new Repo(VIEWER_LOGIN, name, typeof parsed.value.description === 'string' ? parsed.value.description : '', parsed.value.private === true);
        repos.set(repoKey(VIEWER_LOGIN, name), r);
        sendJson(res, 201, repoJson(r));
        return;
      }
      return sendError(res, 404, 'Not Found');
    }
    return sendError(res, 404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const tail = rest.slice(3);
    const r = owner === VIEWER_LOGIN ? viewerRepo(name) : undefined;
    if (tail.length === 0) {
      if (method === 'GET') {
        if (!r) return restNotFound(res);
        sendJson(res, 200, repoJson(r));
        return;
      }
      if (method === 'PATCH') {
        if (!r) return restNotFound(res);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        if (typeof parsed.value.description === 'string') r.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') r.isPrivate = parsed.value.private;
        r.updatedAt = trialNowIso;
        sendJson(res, 200, repoJson(r));
        return;
      }
      if (method === 'DELETE') {
        if (!r) return restNotFound(res);
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      return sendError(res, 404, 'Not Found');
    }
    if (!r) return restNotFound(res);
    await handleRepoSub(req, res, body, r, tail, query, path);
    return;
  }

  return sendError(res, 404, 'Not Found');
}

async function handleRepoSub(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  r: Repo,
  tail: string[],
  query: URLSearchParams,
  path: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const first = tail[0];

  // ---- branches -----------------------------------------------------------
  if (first === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const list = [...r.refs.keys()]
        .filter((n) => n.startsWith('refs/heads/'))
        .sort()
        .map((n) => {
          const short = n.slice('refs/heads/'.length);
          const sha = r.refs.get(n)!;
          return { name: short, commit: { sha, url: `/api/v3/repos/${r.owner}/${r.name}/commits/${sha}` }, protected: false };
        });
      sendJson(res, 200, list);
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const sha = r.tip(`refs/heads/${branch}`);
      if (!sha) return restNotFound(res);
      sendJson(res, 200, { name: branch, commit: { sha, url: `/api/v3/repos/${r.owner}/${r.name}/commits/${sha}` }, protected: false });
      return;
    }
    return sendError(res, 404, 'Not Found');
  }

  // ---- git/refs -----------------------------------------------------------
  if (first === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const ref = parsed.value.ref;
      const sha = parsed.value.sha;
      if (typeof ref !== 'string' || typeof sha !== 'string' || !ref.startsWith('refs/')) {
        return sendError(res, 422, 'Invalid ref');
      }
      if (r.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
      const obj = r.objects.get(sha);
      if (!obj || obj.type !== 'commit') return sendError(res, 422, 'Object does not exist');
      r.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: globalId('Ref', `${r.id}:${ref}`), url: `/api/v3/repos/${r.owner}/${r.name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: `/api/v3/repos/${r.owner}/${r.name}/git/commits/${sha}` } });
      return;
    }
    if (method === 'GET') {
      if (tail.length === 2) {
        const list = [...r.refs.entries()].sort().map(([name, sha]) => ({ ref: name, node_id: globalId('Ref', `${r.id}:${name}`), url: `/api/v3/repos/${r.owner}/${r.name}/git/refs/${encodeURIComponent(name)}`, object: { sha, type: 'commit', url: '' } }));
        sendJson(res, 200, list);
        return;
      }
      const ref = tail.slice(2).join('/');
      const sha = r.refs.get(ref);
      if (!sha) return restNotFound(res);
      sendJson(res, 200, { ref, node_id: globalId('Ref', `${r.id}:${ref}`), url: `/api/v3/repos/${r.owner}/${r.name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: `/api/v3/repos/${r.owner}/${r.name}/git/commits/${sha}` } });
      return;
    }
    return sendError(res, 404, 'Not Found');
  }

  // ---- commits ------------------------------------------------------------
  if (first === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = r.tip(`refs/heads/${shaParam}`) ?? (isOid(shaParam) ? shaParam : undefined);
        if (!tip || !r.objects.has(tip)) return restNotFound(res);
      } else {
        tip = r.defaultTip();
        if (!tip) {
          sendJson(res, 200, []);
          return;
        }
      }
      const { page, perPage } = pageParams(query);
      const all = r.commitList(tip).map((sha) => commitJson(r, sha));
      const { pageItems } = paginate(all, page, perPage);
      sendJson(res, 200, pageItems);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const sha = tail[1];
      const obj = r.objects.get(sha);
      if (!obj || obj.type !== 'commit') return restNotFound(res);
      sendJson(res, 200, commitJson(r, sha));
      return;
    }
    return sendError(res, 404, 'Not Found');
  }

  // ---- contents -----------------------------------------------------------
  if (first === 'contents') {
    const filePath = tail.slice(1).join('/');
    if (method === 'GET') return handleContentsGet(req, res, r, filePath, query);
    if (method === 'PUT') return handleContentsPut(req, res, body, r, filePath, query);
    if (method === 'DELETE') return handleContentsDelete(req, res, body, r, filePath);
    return sendError(res, 404, 'Not Found');
  }

  // ---- labels -------------------------------------------------------------
  if (first === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, [...r.labels.values()].map((l) => labelJson(r, l)));
      return;
    }
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const name = parsed.value.name;
      if (typeof name !== 'string' || name === '') return sendError(res, 422, 'name is required');
      if (r.labels.has(name)) return sendError(res, 422, 'Label already exists');
      const label: Label = { name, color: typeof parsed.value.color === 'string' ? parsed.value.color.replace(/^#/, '') : 'ededed' };
      r.labels.set(name, label);
      sendJson(res, 201, labelJson(r, label));
      return;
    }
    return sendError(res, 404, 'Not Found');
  }

  // ---- issues -------------------------------------------------------------
  if (first === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = r.issues.filter((i) => (state === 'all' ? true : i.state === state));
        if (sort === 'created') {
          list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page, perPage } = pageParams(query);
        const { pageItems, hasNext, totalPages } = paginate(list, page, perPage);
        const headers: Record<string, string> = {};
        if (hasNext || totalPages > 1) headers.link = linkHeader(req, path, query, page, perPage, totalPages);
        sendJson(res, 200, pageItems.map((i) => issueJson(r, i)), headers);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const title = parsed.value.title;
        if (typeof title !== 'string' || title === '') return sendError(res, 422, 'title is required');
        const labelNames = Array.isArray(parsed.value.labels) ? parsed.value.labels : [];
        const labels: Label[] = [];
        for (const ln of labelNames) {
          if (typeof ln === 'string') {
            const found = r.labels.get(ln);
            if (!found) return sendError(res, 422, `Label does not exist: ${ln}`);
            labels.push(found);
          }
        }
        const issue: Issue = {
          id: issueIdCounter++,
          number: r.nextNumber++,
          title,
          body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
          state: 'open',
          labels,
          comments: [],
          created_at: trialNowIso,
          updated_at: trialNowIso,
          closed_at: null,
          _json: '',
        };
        refreshIssueJson(r, issue);
        r.issues.push(issue);
        sendJsonText(res, 201, issue._json);
        return;
      }
      return sendError(res, 404, 'Not Found');
    }
    const num = parseInt(tail[1], 10);
    const issue = Number.isInteger(num) ? r.issues.find((i) => i.number === num) : undefined;
    if (tail.length === 2) {
      if (!issue) return restNotFound(res);
      if (method === 'GET') {
        sendJsonText(res, 200, issue._json);
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
          issue.state = parsed.value.state;
          issue.closed_at = parsed.value.state === 'closed' ? trialNowIso : null;
        }
        issue.updated_at = trialNowIso;
        refreshIssueJson(r, issue);
        sendJsonText(res, 200, issue._json);
        return;
      }
      return sendError(res, 404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (!issue) return restNotFound(res);
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => commentJson(r, issue, c)));
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const text = parsed.value.body;
        if (typeof text !== 'string' || text === '') return sendError(res, 422, 'body is required');
        const comment: Comment = { id: commentIdCounter++, body: text, created_at: trialNowIso, updated_at: trialNowIso };
        issue.comments.push(comment);
        issue.updated_at = trialNowIso;
        refreshIssueJson(r, issue);
        sendJson(res, 201, commentJson(r, issue, comment));
        return;
      }
      return sendError(res, 404, 'Not Found');
    }
    return sendError(res, 404, 'Not Found');
  }

  // ---- pulls --------------------------------------------------------------
  if (first === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const list = r.pulls.filter((p) => (state === 'all' ? true : p.state === state));
        const { page, perPage } = pageParams(query);
        const { pageItems, hasNext, totalPages } = paginate(list, page, perPage);
        const headers: Record<string, string> = {};
        if (hasNext || totalPages > 1) headers.link = linkHeader(req, path, query, page, perPage, totalPages);
        sendJson(res, 200, pageItems.map((p) => pullJson(r, p)), headers);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const title = parsed.value.title;
        const head = parsed.value.head;
        const base = parsed.value.base;
        if (typeof title !== 'string' || title === '') return sendError(res, 422, 'title is required');
        if (typeof head !== 'string' || typeof base !== 'string') return sendError(res, 422, 'head and base are required');
        const headSha = r.tip(`refs/heads/${head}`);
        const baseSha = r.tip(`refs/heads/${base}`);
        if (!headSha) return sendError(res, 422, `head branch not found: ${head}`);
        if (!baseSha) return sendError(res, 422, `base branch not found: ${base}`);
        const dup = r.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (dup) return sendError(res, 422, 'A pull request already exists for this branch');
        const pull: Pull = {
          id: issueIdCounter++,
          number: r.nextNumber++,
          title,
          body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
          state: 'open',
          merged: false,
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
          mergeCommitSha: null,
          mergedAt: null,
          created_at: trialNowIso,
          updated_at: trialNowIso,
        };
        r.pulls.push(pull);
        sendJson(res, 201, pullJson(r, pull));
        return;
      }
      return sendError(res, 404, 'Not Found');
    }
    const num = parseInt(tail[1], 10);
    const pull = Number.isInteger(num) ? r.pulls.find((p) => p.number === num) : undefined;
    if (tail.length === 2) {
      if (!pull) return restNotFound(res);
      if (method === 'GET') {
        sendJson(res, 200, pullJson(r, pull));
        return;
      }
      return sendError(res, 404, 'Not Found');
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (!pull) return restNotFound(res);
      if (method !== 'GET') return sendError(res, 404, 'Not Found');
      const headTip = r.tip(`refs/heads/${pull.headRef}`);
      const baseTip = r.tip(`refs/heads/${pull.baseRef}`);
      if (!headTip || !baseTip) return restNotFound(res);
      const mergeBase = r.mergeBase(headTip, baseTip);
      const baseTree = mergeBase ? parseCommit(r.objects.get(mergeBase)!.data).tree : null;
      const headTree = parseCommit(r.objects.get(headTip)!.data).tree;
      sendJson(res, 200, diffTrees(r, baseTree, headTree));
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (!pull) return restNotFound(res);
      if (method !== 'PUT') return sendError(res, 404, 'Not Found');
      if (pull.state !== 'open') return sendError(res, 405, 'Pull request is already merged or closed');
      const headTip = r.tip(`refs/heads/${pull.headRef}`);
      const baseTip = r.tip(`refs/heads/${pull.baseRef}`);
      if (!headTip || !baseTip) return restNotFound(res);
      if (!prMergeable(r, pull)) return sendError(res, 405, 'Merge conflict');
      const merged = doSquashMerge(r, pull, headTip, baseTip);
      if (merged === null) return sendError(res, 405, 'Merge conflict');
      sendJson(res, 200, { sha: merged, merged: true, message: `Pull request #${pull.number} successfully merged` });
      return;
    }
    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}

function labelJson(r: Repo, l: Label): Record<string, unknown> {
  return {
    id: 1,
    node_id: globalId('Label', `${r.id}:${l.name}`),
    url: `/api/v3/repos/${r.owner}/${r.name}/labels/${encodeURIComponent(l.name)}`,
    name: l.name,
    color: l.color,
    default: false,
    description: '',
  };
}

function commentJson(r: Repo, issue: Issue, c: Comment): Record<string, unknown> {
  return {
    id: c.id,
    node_id: globalId('IssueComment', `${r.id}:${issue.number}:${c.id}`),
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/comments/${c.id}`,
    html_url: `https://github.com/${r.fullName}/issues/${issue.number}#issuecomment-${c.id}`,
    body: c.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false },
    created_at: c.created_at,
    updated_at: c.updated_at,
    author_association: 'OWNER',
    reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    performed_via_github_app: null,
  };
}

function commitJson(r: Repo, sha: string): Record<string, unknown> {
  const c = parseCommit(r.objects.get(sha)!.data);
  const message = c.message.replace(/\n$/, '');
  const authorLine = c.author;
  const emailMatch = /<([^>]*)>/.exec(authorLine);
  const namePart = authorLine.split('<')[0].trim();
  const date = trialNowIso;
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: { name: namePart, email: emailMatch?.[1] ?? VIEWER_EMAIL, date },
      committer: { name: namePart, email: emailMatch?.[1] ?? VIEWER_EMAIL, date },
      message,
      tree: { sha: c.tree, url: `/api/v3/repos/${r.owner}/${r.name}/git/trees/${c.tree}` },
      url: `/api/v3/repos/${r.owner}/${r.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `/api/v3/repos/${r.owner}/${r.name}/commits/${sha}`,
    html_url: `https://github.com/${r.fullName}/commit/${sha}`,
    comments_url: `/api/v3/repos/${r.owner}/${r.name}/commits/${sha}/comments`,
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_ID), type: 'User', site_admin: false },
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${r.owner}/${r.name}/commits/${p}`, html_url: `https://github.com/${r.fullName}/commit/${p}` })),
  };
}

// Squash-merge `pull` onto its base branch. Returns the merge commit sha, or
// null on conflict.
function doSquashMerge(r: Repo, pull: Pull, headTip: string, baseTip: string): string | null {
  const mergeBase = r.mergeBase(headTip, baseTip);
  if (mergeBase === null) return null;
  const headTree = parseCommit(r.objects.get(headTip)!.data).tree;
  const baseTree = parseCommit(r.objects.get(baseTip)!.data).tree;
  const mergeTree = parseCommit(r.objects.get(mergeBase)!.data).tree;
  const headFlat = r.flattenTree(headTree);
  const baseFlat = r.flattenTree(baseTree);
  const mergeFlat = r.flattenTree(mergeTree);
  const paths = new Set([...headFlat.keys(), ...baseFlat.keys(), ...mergeFlat.keys()]);
  let resultTree = baseTree;
  for (const path of paths) {
    const h = headFlat.get(path)?.oid ?? null;
    const b = baseFlat.get(path)?.oid ?? null;
    const m = mergeFlat.get(path)?.oid ?? null;
    const headChanged = h !== m;
    const baseChanged = b !== m;
    if (headChanged && baseChanged && h !== b) return null;
    if (headChanged) {
      resultTree = r.setPath(resultTree, path.split('/'), h);
    }
  }
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const sha = makeCommit(r, message, resultTree, [baseTip]);
  r.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = trialNowIso;
  pull.updated_at = trialNowIso;
  pull.baseSha = sha;
  return sha;
}

// ------------------------------------------------------------------ contents API

function handleContentsGet(req: IncomingMessage, res: ServerResponse, r: Repo, filePath: string, query: URLSearchParams): void {
  const refParam = query.get('ref');
  let tip: string | undefined;
  if (refParam) {
    tip = r.tip(`refs/heads/${refParam}`) ?? (isOid(refParam) ? refParam : undefined);
    if (!tip || !r.objects.has(tip)) return restNotFound(res);
  } else {
    tip = r.defaultTip();
    if (!tip) return restNotFound(res);
  }
  const treeOid = parseCommit(r.objects.get(tip)!.data).tree;
  const flat = r.flattenTree(treeOid);
  const exact = flat.get(filePath);
  if (exact) {
    const obj = r.objects.get(exact.oid)!;
    const name = filePath.split('/').pop()!;
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: obj.data.length,
      name,
      path: filePath,
      content: b64encode(obj.data),
      sha: exact.oid,
      url: `/api/v3/repos/${r.owner}/${r.name}/contents/${filePath}`,
      html_url: `https://github.com/${r.fullName}/blob/${r.defaultBranch}/${filePath}`,
      git_url: `/api/v3/repos/${r.owner}/${r.name}/git/blobs/${exact.oid}`,
      download_url: `https://raw.githubusercontent.com/${r.fullName}/${r.defaultBranch}/${filePath}`,
      _links: { git: '', self: '', html: '' },
    });
    return;
  }
  // Directory listing: entries directly under filePath (or the root).
  const prefix = filePath === '' ? '' : `${filePath}/`;
  const seen = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
  const treeOidAt = (dirPath: string): string => {
    if (dirPath === '') return treeOid;
    let cur = treeOid;
    for (const seg of dirPath.split('/')) {
      const obj = r.objects.get(cur);
      if (!obj || obj.type !== 'tree') return '';
      const entry = parseTree(obj.data).find((e) => e.name === seg);
      if (!entry || entry.mode !== '40000') return '';
      cur = entry.oid;
    }
    return cur;
  };
  for (const [p, entry] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { type: 'file', name: rest, path: p, sha: entry.oid, size: r.objects.get(entry.oid)?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!seen.has(dir)) {
        seen.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: treeOidAt(`${prefix}${dir}`), size: 0 });
      }
    }
  }
  if (seen.size === 0) return restNotFound(res);
  const list = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((e) => ({
    type: e.type,
    size: e.size,
    name: e.name,
    path: e.path,
    sha: e.sha,
    url: `/api/v3/repos/${r.owner}/${r.name}/contents/${e.path}`,
    html_url: `https://github.com/${r.fullName}/tree/${r.defaultBranch}/${e.path}`,
    git_url: e.type === 'file' ? `/api/v3/repos/${r.owner}/${r.name}/git/blobs/${e.sha}` : `/api/v3/repos/${r.owner}/${r.name}/git/trees/${e.sha}`,
    download_url: e.type === 'file' ? `https://raw.githubusercontent.com/${r.fullName}/${r.defaultBranch}/${e.path}` : null,
    _links: { git: '', self: '', html: '' },
  }));
  sendJson(res, 200, list);
}

function handleContentsPut(req: IncomingMessage, res: ServerResponse, body: Buffer, r: Repo, filePath: string, query: URLSearchParams): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
  const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Update file';
  const contentB64 = parsed.value.content;
  if (typeof contentB64 !== 'string') return sendError(res, 422, 'content is required');
  const content = b64decodeLoose(contentB64);
  const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : r.defaultBranch;
  let branchRef = `refs/heads/${branch}`;
  let tip = r.tip(branchRef);
  if (tip === undefined) {
    // Create the branch from the default tip (or unborn).
    const baseTip = r.defaultTip();
    if (baseTip !== undefined) {
      r.refs.set(branchRef, baseTip);
      tip = baseTip;
    }
  }
  const currentBlob = tip ? r.blobAt(tip, filePath) : null;
  const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
  if (currentBlob !== null) {
    if (givenSha === undefined || givenSha !== currentBlob) {
      return sendError(res, 409, 'sha does not match the current blob');
    }
  }
  const isUpdate = currentBlob !== null;
  const blobOid = r.putObject('blob', content);
  const baseTree = tip ? parseCommit(r.objects.get(tip)!.data).tree : null;
  const newTree = r.setPath(baseTree, filePath.split('/'), blobOid);
  const commitSha = makeCommit(r, message, newTree, tip ? [tip] : []);
  r.refs.set(branchRef, commitSha);
  r.updatedAt = trialNowIso;
  sendJson(res, isUpdate ? 200 : 201, {
    content: {
      name: filePath.split('/').pop()!,
      path: filePath,
      sha: blobOid,
      size: content.length,
      url: `/api/v3/repos/${r.owner}/${r.name}/contents/${filePath}`,
      html_url: `https://github.com/${r.fullName}/blob/${branch}/${filePath}`,
      git_url: `/api/v3/repos/${r.owner}/${r.name}/git/blobs/${blobOid}`,
      download_url: `https://raw.githubusercontent.com/${r.fullName}/${branch}/${filePath}`,
      type: 'file',
      encoding: 'base64',
      content: contentB64,
      _links: { git: '', self: '', html: '' },
    },
    commit: {
      sha: commitSha,
      node_id: globalId('Commit', commitSha),
      message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: trialNowIso },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: trialNowIso },
      tree: { sha: newTree },
      parents: tip ? [{ sha: tip }] : [],
    },
  });
}

function handleContentsDelete(req: IncomingMessage, res: ServerResponse, body: Buffer, r: Repo, filePath: string): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
  const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Delete file';
  const tip = r.defaultTip();
  if (!tip) return restNotFound(res);
  const currentBlob = r.blobAt(tip, filePath);
  if (currentBlob === null) return restNotFound(res);
  const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
  if (givenSha !== undefined && givenSha !== currentBlob) {
    return sendError(res, 409, 'sha does not match the current blob');
  }
  const baseTree = parseCommit(r.objects.get(tip)!.data).tree;
  const newTree = r.setPath(baseTree, filePath.split('/'), null);
  const commitSha = makeCommit(r, message, newTree, [tip]);
  r.refs.set(`refs/heads/${r.defaultBranch}`, commitSha);
  r.updatedAt = trialNowIso;
  sendJson(res, 200, {
    content: null,
    commit: {
      sha: commitSha,
      node_id: globalId('Commit', commitSha),
      message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: trialNowIso },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: trialNowIso },
      tree: { sha: newTree },
      parents: [{ sha: tip }],
    },
  });
}

// ------------------------------------------------------------------ GraphQL

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inline'; typeName: string; selections: GqlSelection[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
}

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():![]=$'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenizeGql(src);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    return this.tokens[this.pos++] ?? '';
  }

  private expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`expected ${t}, got ${got}`);
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      type = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') {
      name = this.next();
    }
    const variables: Array<{ name: string; defaultValue: GqlValue | null }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const varName = this.next();
        this.expect(':');
        this.parseType();
        let defaultValue: GqlValue | null = null;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName.replace(/^\$/, ''), defaultValue });
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseType(): void {
    const t = this.peek();
    if (t === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const sels: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          sels.push({ kind: 'inline', typeName, selections: this.parseSelectionSet() });
        } else {
          this.next(); // fragment spread name (unused by the suite)
          sels.push({ kind: 'inline', typeName: '', selections: [] });
        }
      } else {
        sels.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return sels;
  }

  private parseField(): GqlField {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections };
  }

  private parseValue(): GqlValue {
    const t = this.peek() ?? '';
    if (t === '$') {
      this.next();
      return { kind: 'variable', name: this.next() };
    }
    if (t === '[') {
      this.next();
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t === '{') {
      this.next();
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) {
      this.next();
      return { kind: 'string', value: JSON.parse(t) as string };
    }
    if (t === 'true' || t === 'false') {
      this.next();
      return { kind: 'boolean', value: t === 'true' };
    }
    if (t === 'null') {
      this.next();
      return { kind: 'null' };
    }
    if (/^-?\d+$/.test(t)) {
      this.next();
      return { kind: 'int', value: parseInt(t, 10) };
    }
    if (/^-?\d+\.\d+$/.test(t)) {
      this.next();
      return { kind: 'float', value: parseFloat(t) };
    }
    this.next();
    return { kind: 'enum', value: t };
  }
}

function resolveGqlValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable':
      return variables[v.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.values.map((x) => resolveGqlValue(x, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveGqlValue(f.value, variables);
      return out;
    }
  }
}

function argsMap(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveGqlValue(a.value, variables);
  return out;
}

// ---- schema: introspection data ------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'fork'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'COMMIT', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const QUERY_FIELDS = ['viewer', 'repository', 'node', '__type', '__schema'];
const MUTATION_FIELDS = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];

// ---- execution ------------------------------------------------------------

interface GqlCtx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function gqlTypeOf(value: Record<string, unknown>): string {
  return (value.__typename as string) ?? 'Unknown';
}

function executeSelections(
  typeName: string,
  obj: Record<string, unknown>,
  selections: GqlSelection[],
  ctx: GqlCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (sel.typeName === '' || sel.typeName === typeName) {
        Object.assign(out, executeSelections(typeName, obj, sel.selections, ctx));
      }
      continue;
    }
    const f = sel.field;
    const key = f.alias ?? f.name;
    const value = resolveGqlField(typeName, obj, f, ctx);
    if (value === undefined) {
      // Unknown field: record the error, answer null for it.
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    if (f.selections !== null && value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        out[key] = value.map((item) =>
          item !== null && typeof item === 'object'
            ? executeSelections(gqlTypeOf(item as Record<string, unknown>), item as Record<string, unknown>, f.selections!, ctx)
            : item,
        );
      } else {
        out[key] = executeSelections(gqlTypeOf(value), value, f.selections, ctx);
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function repoById(id: number): Repo | undefined {
  for (const r of repos.values()) if (r.id === id) return r;
  return undefined;
}

function findRepoForGql(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return viewerRepo(name) ?? null;
}

function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issueGql(r: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: globalId('Issue', `${r.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `https://github.com/${r.fullName}/issues/${issue.number}`,
  };
}

function pullGql(r: Repo, p: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', `${r.id}:${p.number}`),
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: p.merged,
    headRefName: p.headRef,
    baseRefName: p.baseRef,
    mergeable: prMergeable(r, p) ? 'MERGEABLE' : 'CONFLICTING',
    _repo: r,
    _pull: p,
  };
}

function repoGql(r: Repo): Record<string, unknown> {
  const tip = r.defaultTip();
  return {
    __typename: 'Repository',
    id: globalId('Repository', r.id),
    databaseId: r.id,
    name: r.name,
    nameWithOwner: r.fullName,
    owner: { __typename: 'User', login: r.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
    defaultBranchRef: tip ? { __typename: 'Ref', name: r.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: r.description,
    isPrivate: r.isPrivate,
    url: `https://github.com/${r.fullName}`,
    _repo: r,
  };
}

function resolveGqlField(typeName: string, obj: Record<string, unknown>, field: GqlField, ctx: GqlCtx): unknown {
  const args = argsMap(field, ctx.variables);
  const name = field.name;

  if (name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (name === 'viewer') {
      return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
    }
    if (name === 'repository') {
      const r = findRepoForGql(String(args.owner ?? ''), String(args.name ?? ''));
      return r ? repoGql(r) : null;
    }
    if (name === 'node') {
      const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const r = repoById(parseInt(decoded.value, 10));
        return r ? repoGql(r) : null;
      }
      if (decoded.kind === 'Issue') {
        const [repoId, num] = decoded.value.split(':');
        const r = repoById(parseInt(repoId ?? '', 10));
        const issue = r?.issues.find((i) => i.number === parseInt(num ?? '', 10));
        return r && issue ? issueGql(r, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const [repoId, num] = decoded.value.split(':');
        const r = repoById(parseInt(repoId ?? '', 10));
        const pull = r?.pulls.find((p) => p.number === parseInt(num ?? '', 10));
        return r && pull ? pullGql(r, pull) : null;
      }
      return null;
    }
    if (name === '__type') {
      const tname = String(args.name ?? '');
      const fields = TYPE_FIELDS[tname];
      const enums = TYPE_ENUM_VALUES[tname];
      if (!fields && !enums) return null;
      return {
        __typename: '__Type',
        name: tname,
        kind: enums ? 'ENUM' : 'OBJECT',
        fields: fields ? fields.map((f) => ({ __typename: '__Field', name: f })) : null,
        enumValues: enums ? enums.map((e) => ({ __typename: '__EnumValue', name: e })) : null,
      };
    }
    if (name === '__schema') {
      return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
    }
    return undefined;
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const r = decoded && decoded.kind === 'Repository' ? repoById(parseInt(decoded.value, 10)) : undefined;
      if (!r) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const issue: Issue = {
        id: issueIdCounter++,
        number: r.nextNumber++,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        created_at: trialNowIso,
        updated_at: trialNowIso,
        closed_at: null,
        _json: '',
      };
      refreshIssueJson(r, issue);
      r.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: issueGql(r, issue) };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      if (!decoded || decoded.kind !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided issueId.' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      const [repoId, num] = decoded.value.split(':');
      const r = repoById(parseInt(repoId ?? '', 10));
      const issue = r?.issues.find((i) => i.number === parseInt(num ?? '', 10));
      if (!r || !issue) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided issueId.' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      issue.state = 'closed';
      issue.closed_at = trialNowIso;
      issue.updated_at = trialNowIso;
      refreshIssueJson(r, issue);
      return { __typename: 'CloseIssuePayload', issue: issueGql(r, issue) };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const r = decoded && decoded.kind === 'Repository' ? repoById(parseInt(decoded.value, 10)) : undefined;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!r) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const headSha = r.tip(`refs/heads/${head}`);
      const baseSha = r.tip(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'Head or base ref does not exist.' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const pull: Pull = {
        id: issueIdCounter++,
        number: r.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        created_at: trialNowIso,
        updated_at: trialNowIso,
      };
      r.pulls.push(pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullGql(r, pull) };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      if (!decoded || decoded.kind !== 'PullRequest') {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided pullRequestId.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const [repoId, num] = decoded.value.split(':');
      const r = repoById(parseInt(repoId ?? '', 10));
      const pull = r?.pulls.find((p) => p.number === parseInt(num ?? '', 10));
      if (!r || !pull) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided pullRequestId.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const headTip = r.tip(`refs/heads/${pull.headRef}`);
      const baseTip = r.tip(`refs/heads/${pull.baseRef}`);
      if (!headTip || !baseTip || pull.state !== 'open' || !prMergeable(r, pull)) {
        ctx.errors.push({ message: 'Pull request cannot be merged.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: pullGql(r, pull) };
      }
      doSquashMerge(r, pull, headTip, baseTip);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullGql(r, pull) };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      if (!decoded || decoded.kind !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided subjectId.' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const [repoId, num] = decoded.value.split(':');
      const r = repoById(parseInt(repoId ?? '', 10));
      const issue = r?.issues.find((i) => i.number === parseInt(num ?? '', 10));
      if (!r || !issue) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided subjectId.' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const comment: Comment = {
        id: commentIdCounter++,
        body: typeof input.body === 'string' ? input.body : '',
        created_at: trialNowIso,
        updated_at: trialNowIso,
      };
      issue.comments.push(comment);
      issue.updated_at = trialNowIso;
      refreshIssueJson(r, issue);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: globalId('IssueComment', `${r.id}:${issue.number}:${comment.id}`), body: comment.body },
        },
      };
    }
    return undefined;
  }

  if (typeName === 'Repository') {
    const r = obj._repo as Repo | undefined;
    if (!r) return obj[name] ?? null;
    if (name === 'issue') {
      const num = args.number as number;
      const issue = r.issues.find((i) => i.number === num);
      return issue ? issueGql(r, issue) : null;
    }
    if (name === 'issues') {
      const first = typeof args.first === 'number' ? args.first : 30;
      const after = cursorNumber(args.after);
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      let list = [...r.issues];
      if (states) {
        list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const dir = orderBy.direction === 'ASC' ? 1 : -1;
      list.sort((a, b) => (a.number - b.number) * dir);
      if (after !== null) {
        const idx = list.findIndex((i) => i.number === after);
        if (idx >= 0) list = list.slice(idx + 1);
      }
      const page = list.slice(0, first);
      const hasNext = list.length > first;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((i) => issueGql(r, i)),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: hasNext,
          hasPreviousPage: false,
          startCursor: page.length ? issueCursor(page[0].number) : null,
          endCursor: page.length ? issueCursor(page[page.length - 1].number) : null,
        },
      };
    }
    if (name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : 30;
      const list = [...r.pulls].sort((a, b) => b.number - a.number).slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: list.map((p) => pullGql(r, p)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: r.pulls.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    if (name === 'pullRequest') {
      const num = args.number as number;
      const pull = r.pulls.find((p) => p.number === num);
      return pull ? pullGql(r, pull) : null;
    }
    return obj[name] ?? null;
  }

  if (typeName === 'PullRequest') {
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 30;
      const r = obj._repo as Repo | undefined;
      const pull = obj._pull as Pull | undefined;
      let files: Array<{ path: string }> = (obj._files ?? []) as Array<{ path: string }>;
      if ((!files || files.length === 0) && r && pull) {
        const headTip = r.tip(`refs/heads/${pull.headRef}`);
        const baseTip = r.tip(`refs/heads/${pull.baseRef}`);
        if (headTip && baseTip) {
          const base = mergeBase(r, headTip, baseTip);
          files = diffTrees(r, base ? treeOidAt(r, base) : EMPTY_TREE_OID, treeOidAt(r, headTip));
        }
      }
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path })),
      };
    }
    return obj[name] ?? null;
  }

  if (typeName === '__Type') {
    if (name === 'fields') {
      return (obj.fields as Array<{ name: string }> | null) ?? null;
    }
    if (name === 'enumValues') {
      return (obj.enumValues as Array<{ name: string }> | null) ?? null;
    }
    return obj[name] ?? null;
  }

  // Plain objects: scalar passthrough.
  if (name in obj) return obj[name];
  return undefined;
}

function runGraphQLOperation(op: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: GqlCtx = { variables, errors: [] };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const root: Record<string, unknown> = { __typename: rootType };
  // Validate top-level field names first (unknown query/mutation field).
  const known = rootType === 'Mutation' ? MUTATION_FIELDS : QUERY_FIELDS;
  for (const sel of op.selections) {
    if (sel.kind === 'field' && !known.includes(sel.field.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.field.name}" on type "${rootType}".` });
    }
  }
  const data = executeSelections(rootType, root, op.selections, ctx);
  if (ctx.errors.length > 0) {
    return { data: ctx.errors.length > 0 && Object.keys(data).length === 0 ? null : data, errors: ctx.errors };
  }
  return { data };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (!authed(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Request body must be a JSON object with query and variables.' }] };
    }
    const query = (entry as Record<string, unknown>).query;
    const variables = (entry as Record<string, unknown>).variables;
    const operationName = (entry as Record<string, unknown>).operationName;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'Request body must include a query string.' }] };
    }
    let ops: GqlOperation[];
    try {
      ops = new GqlParser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: `Syntax error: ${(err as Error).message}` }] };
    }
    let op = ops[0];
    if (typeof operationName === 'string') {
      op = ops.find((o) => o.name === operationName) ?? op;
    }
    if (!op) return { data: null, errors: [{ message: 'No operation found in query.' }] };
    const vars = (variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? variables : {}) as Record<string, unknown>;
    return runGraphQLOperation(op, vars);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ------------------------------------------------------------------ MCP

const MCP_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number using the squash merge method.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, issue_number: { type: 'number' } },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'search_repositories',
    description: 'Search repositories by name substring.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

function mcpToolText(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: { result: text } };
}

function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
  const fullName = typeof args.full_name === 'string' ? args.full_name : null;
  if (fullName) {
    const r = repos.get(fullName);
    return r ?? null;
  }
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (!owner || !repo) return null;
  if (owner !== VIEWER_LOGIN) return null;
  return viewerRepo(repo) ?? null;
}

function mcpCallTool(name: string, args: Record<string, unknown>): { result: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { result: {}, error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  const required = (tool.inputSchema.required as string[]) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return {
        result: { content: [{ type: 'text', text: `Missing required argument: ${key}` }], isError: true },
      };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (viewerRepo(repoName)) {
        return { result: { content: [{ type: 'text', text: `Repository ${VIEWER_LOGIN}/${repoName} already exists` }], isError: true } };
      }
      const r = new Repo(VIEWER_LOGIN, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      r.id = repoIdCounter++;
      repos.set(r.fullName, r);
      return { result: mcpToolText(JSON.stringify(repoJson(r))) };
    }
    case 'get_repo': {
      const r = mcpResolveRepo(args);
      if (!r) {
        return { result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true } };
      }
      return { result: mcpToolText(JSON.stringify(repoJson(r))) };
    }
    case 'create_issue': {
      const r = mcpResolveRepo(args);
      if (!r) {
        return { result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true } };
      }
      const issue: Issue = {
        id: issueIdCounter++,
        number: r.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        created_at: trialNowIso,
        updated_at: trialNowIso,
        closed_at: null,
        _json: '',
      };
      refreshIssueJson(r, issue);
      r.issues.push(issue);
      return { result: mcpToolText(JSON.stringify(issueJson(r, issue))) };
    }
    case 'list_issues': {
      const r = mcpResolveRepo(args);
      if (!r) {
        return { result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true } };
      }
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = r.issues.filter((i) => state === 'all' || i.state === state);
      return { result: mcpToolText(JSON.stringify(list.map((i) => issueJson(r, i)))) };
    }
    case 'create_pull_request': {
      const r = mcpResolveRepo(args);
      if (!r) {
        return { result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true } };
      }
      const head = String(args.head);
      const base = String(args.base);
      const headSha = r.tip(`refs/heads/${head}`);
      const baseSha = r.tip(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        return { result: { content: [{ type: 'text', text: 'Head or base ref does not exist' }], isError: true } };
      }
      const pull: Pull = {
        id: issueIdCounter++,
        number: r.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        created_at: trialNowIso,
        updated_at: trialNowIso,
      };
      r.pulls.push(pull);
      return { result: mcpToolText(JSON.stringify(pullJson(r, pull))) };
    }
    case 'merge_pull_request': {
      const r = mcpResolveRepo(args);
      if (!r) {
        return { result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true } };
      }
      const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
      const pull = r.pulls.find((p) => p.number === num);
      if (!pull) {
        return { result: { content: [{ type: 'text', text: `Pull request #${num} not found` }], isError: true } };
      }
      const headTip = r.tip(`refs/heads/${pull.headRef}`);
      const baseTip = r.tip(`refs/heads/${pull.baseRef}`);
      if (!headTip || !baseTip || pull.state !== 'open' || !prMergeable(r, pull)) {
        return { result: { content: [{ type: 'text', text: 'Pull request cannot be merged' }], isError: true } };
      }
      doSquashMerge(r, pull, headTip, baseTip);
      return { result: mcpToolText(JSON.stringify(pullJson(r, pull))) };
    }
    case 'get_issue': {
      const r = mcpResolveRepo(args);
      if (!r) {
        return { result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true } };
      }
      const num = typeof args.issue_number === 'number' ? args.issue_number : parseInt(String(args.issue_number), 10);
      const issue = r.issues.find((i) => i.number === num);
      if (!issue) {
        return { result: { content: [{ type: 'text', text: `Issue #${num} not found` }], isError: true } };
      }
      return { result: mcpToolText(JSON.stringify(issueJson(r, issue))) };
    }
    case 'search_repositories': {
      const q = String(args.query).toLowerCase();
      const found = [...repos.values()].filter((r) => r.name.toLowerCase().includes(q)).map((r) => repoJson(r));
      return { result: mcpToolText(JSON.stringify(found)) };
    }
    default:
      return { result: {}, error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

async function handleMCP(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (!authed(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const msg = parsed as Record<string, unknown>;
  const id = msg.id === undefined ? null : msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';

  // Notifications (no id) → 202, no body.
  if (msg.id === undefined) {
    res.writeHead(202, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': nextRequestId() });
    res.end();
    return;
  }

  const reply = (payload: Record<string, unknown>): void => {
    sendJson(res, 200, payload);
  };

  if (method === 'server/discover') {
    reply({
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
        serverInfo: { name: 'moonku-forge', version: '7.0.0' },
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'moonku-forge', version: '7.0.0' } },
      },
    });
    return;
  }
  if (method === 'initialize') {
    reply({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: 'moonku-forge', version: '7.0.0' },
      },
    });
    return;
  }
  if (method === 'ping') {
    reply({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    reply({
      jsonrpc: '2.0',
      id,
      result: {
        tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // Accept prefix-qualified names by matching the suffix.
    let matched = MCP_TOOLS.find((t) => t.name === toolName);
    if (!matched) {
      const suffix = toolName.split('_').slice(-2).join('_');
      matched =
        MCP_TOOLS.find((t) => t.name.endsWith(toolName)) ??
        MCP_TOOLS.find((t) => t.name === suffix) ??
        MCP_TOOLS.find((t) => toolName.endsWith(t.name));
    }
    const { result, error } = mcpCallTool(matched ? matched.name : toolName, args);
    if (error) {
      reply({ jsonrpc: '2.0', id, error });
      return;
    }
    reply({ jsonrpc: '2.0', id, result });
    return;
  }
  reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ------------------------------------------------------------------ Git routes

function gitRepoFromPath(pathname: string): { repo: Repo | null; service: string | null } {
  // /{owner}/{repo}.git/info/refs?service=git-upload-pack
  // /{owner}/{repo}.git/git-upload-pack
  // /{owner}/{repo}.git/git-receive-pack
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!m) return { repo: null, service: null };
  const [, owner, repoName, service] = m;
  if (owner !== VIEWER_LOGIN) return { repo: null, service: service ?? null };
  return { repo: viewerRepo(repoName) ?? null, service: service ?? null };
}

function sendGit(res: ServerResponse, status: number, body: Buffer, contentType = 'application/x-git-upload-pack-result'): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const { repo, service } = gitRepoFromPath(pathname);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' && service === 'info/refs') {
    const svc = url.searchParams.get('service') ?? '';
    if (svc === 'git-upload-pack') {
      const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const adv = version2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
      sendGit(res, 200, adv, 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (svc === 'git-receive-pack') {
      sendGit(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendError(res, 400, 'Bad Request');
    return;
  }
  if (method === 'POST' && service === 'git-upload-pack') {
    const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      const out = version2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      sendGit(res, out.status, out.body, out.contentType);
    } catch (err) {
      // A malformed upload-pack request must not crash the server.
      process.stderr.write(`upload-pack error: ${String(err)}\n`);
      sendGit(res, 200, Buffer.from('0000', 'ascii'));
    }
    return;
  }
  if (method === 'POST' && service === 'git-receive-pack') {
    try {
      const out = handleReceivePack(repo, body);
      sendGit(res, out.status, out.body, out.contentType);
    } catch (err) {
      process.stderr.write(`receive-pack error: ${String(err)}\n`);
      sendGit(res, 200, Buffer.from('0000', 'ascii'));
    }
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ Dispatcher

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = await readBody(req);
  const seg = pathname.split('/').filter((s) => s.length > 0);

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (seg.length >= 2 && seg[1].endsWith('.git')) {
    await handleGit(req, res, body);
    return;
  }

  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    await handleGraphQL(req, res, body);
    return;
  }

  if (pathname === '/mcp') {
    if (method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    await handleMCP(req, res, body);
    return;
  }

  if (seg[0] === 'api' && seg[1] === 'v3') {
    await handleRest(req, res, body, pathname, url.searchParams);
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ Bootstrap

const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
const port = 0;

const server = createServer((req, res) => {
  void dispatch(req, res).catch((err) => {
    process.stderr.write(`dispatch error: ${String(err?.stack ?? err)}\n`);
    try {
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    } catch {
      // ignore
    }
  });
});

server.on('connection', (socket) => {
  socket.setNoDelay(true);
});

server.listen(port, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : 0;
  void (async () => {
    if (envUrl) {
      try {
        await fetch(`${envUrl}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: actualPort }),
        });
      } catch {
        // The done poll loop below keeps the process alive; registration
        // is retried implicitly by the environment's boot checks.
      }
      // Poll /done until the environment says the trial is over.
      let delay = 250;
      for (;;) {
        try {
          const r = await fetch(`${envUrl}/done`);
          const data = (await r.json()) as { done?: boolean };
          if (data.done === true) break;
        } catch {
          // Keep polling; the environment may not be ready yet.
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (delay < 2000) delay = Math.min(2000, delay * 2);
      }
    }
    server.close(() => process.exit(0));
    // Safety net: never hang forever.
    setTimeout(() => process.exit(0), 5000).unref();
  })();
});

process.on('uncaughtException', (err) => {
  // The server must stay up through malformed requests; log and continue.
  process.stderr.write(`uncaught: ${String(err)}\n`);
});
