// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection, line matching at
// three tiers, unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits
// (section 9) and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Whether file line `a` equals patch line `b` at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

function occursAt(lines: string[], o: string[], pos: number, tier: number): boolean {
  if (pos < 0 || pos + o.length > lines.length) return false;
  for (let j = 0; j < o.length; j++) {
    if (!lineEq(lines[pos + j]!, o[j]!, tier)) return false;
  }
  return true;
}

/** Every position at or after `from` where O occurs at a tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    if (occursAt(lines, o, i, tier)) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function firstTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier where one is. */
function findSingleLine(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/**
 * A line of N that is not a context line, at tier 2 (SPEC.md section 5): F is the leading spaces and tabs of the
 * file's first matched line, P those of O's first line; a line that is not empty and not only whitespace, and starts
 * with P, has that P replaced by F. At tiers 0 and 1, and for any other line, it is written as it is.
 */
function reindentLine(line: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as (old, new) pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** The path's state after the patch: the edit's value when touched, else its original. */
  finalOf(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One output line of a replacement: a context line (the file's own matched line) or an added line. */
type NPart = { kind: 'ctx'; oIndex: number } | { kind: 'add'; text: string };

/** N's lines at a matched position: context lines are the file's own, other lines re-indented at tier 2. */
function replacementLines(lines: string[], pos: number, o: string[], parts: NPart[], tier: number): string[] {
  const f = leadingWS(lines[pos]!);
  const p = leadingWS(o[0]!);
  return parts.map((x) => (x.kind === 'ctx' ? lines[pos + x.oIndex]! : reindentLine(x.text, tier, f, p)));
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** The hunk header's old start (1-based). */
  a: number;
  /** Context and `-` lines, in body order. */
  o: string[];
  /** Context and `+` lines, in body order. */
  parts: NPart[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastCtxOrPlusBackslash: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusBackslash: boolean;
  plusCount: number;
}

interface UniSection {
  /** null when the old path is /dev/null. */
  oldPath: string | null;
  /** null when the new path is /dev/null. */
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a leading a/ or b/ removed. */
function uniPath(text: string): string {
  const t = text.split('\t')[0]!.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseDiffGit(line: string, i: number): { old: string; new: string } {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  return { old: m[1]!, new: m[2]! };
}

function parseHunkHeader(line: string, i: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  return parseInt(m[1]!, 10);
}

/**
 * A hunk's body: the lines after its header that start with ` `, `-`, `+` or `\`, or are empty. It ends at the first
 * other line, at a `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at the end of the patch; empty
 * lines at the end of a body are not part of it.
 */
function collectBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const parts: NPart[] = [];
  let plusCount = 0;
  let lastCtxNew = -1;
  let lastPlus = -1;
  for (let j = 0; j < body.length; j++) {
    const l = body[j]!;
    if (l[0] === ' ' || l === '' || l[0] === '+') lastCtxNew = j;
    if (l[0] === '+') {
      lastPlus = j;
      plusCount++;
    }
  }
  const backslashAfter = (j: number): boolean => j >= 0 && j + 1 < body.length && body[j + 1]![0] === '\\';
  for (const l of body) {
    if (l[0] === ' ' || l === '') {
      const text = l === '' ? '' : l.slice(1);
      o.push(text);
      parts.push({ kind: 'ctx', oIndex: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      parts.push({ kind: 'add', text: l.slice(1) });
    }
    // `\` lines are not part of O or N; they only say a line has no line break.
  }
  return {
    a,
    o,
    parts,
    lastCtxOrPlusBackslash: backslashAfter(lastCtxNew),
    lastPlusBackslash: backslashAfter(lastPlus),
    plusCount,
  };
}

interface UniBuilder {
  oldPath?: string;
  newPath?: string;
  hasPair: boolean;
  renameFrom?: string;
  renameTo?: string;
  diffOld?: string;
  diffNew?: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function buildUniSection(b: UniBuilder): UniSection {
  let oldRaw: string;
  let newRaw: string;
  if (b.hasPair) {
    oldRaw = b.oldPath ?? '';
    newRaw = b.newPath ?? '';
  } else {
    oldRaw = b.renameFrom ?? b.diffOld ?? '';
    newRaw = b.renameTo ?? b.diffNew ?? '';
  }
  const oldPath = oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === '/dev/null' ? null : newRaw;
  return { oldPath, newPath, isCreate: oldPath === null || b.isCreate, isDelete: newPath === null || b.isDelete, hunks: b.hunks };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  const n = lines.length;
  let cur: UniBuilder | null = null;
  let state: 'outside' | 'header' | 'between' = 'outside';
  const finish = (): void => {
    if (cur !== null) {
      sections.push(buildUniSection(cur));
      cur = null;
    }
  };
  const startDiff = (line: string, i: number): void => {
    const dg = parseDiffGit(line, i);
    cur = { hasPair: false, diffOld: dg.old, diffNew: dg.new, isCreate: false, isDelete: false, hunks: [] };
    state = 'header';
  };
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (state === 'outside') {
      if (line.startsWith('diff --git ')) {
        startDiff(line, i);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = { hasPair: true, oldPath: uniPath(line.slice(4)), newPath: uniPath(lines[i + 1]!.slice(4)), isCreate: false, isDelete: false, hunks: [] };
        state = 'header';
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
    } else if (state === 'header') {
      if (line.startsWith('diff --git ')) {
        finish();
        startDiff(line, i);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur!.oldPath = uniPath(line.slice(4));
        cur!.newPath = uniPath(lines[i + 1]!.slice(4));
        cur!.hasPair = true;
        i += 2;
      } else if (line.startsWith('--- ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      } else if (line.startsWith('rename from ')) {
        cur!.renameFrom = line.slice(12).trim();
        i++;
      } else if (line.startsWith('rename to ')) {
        cur!.renameTo = line.slice(10).trim();
        i++;
      } else if (line.startsWith('new file mode')) {
        cur!.isCreate = true;
        i++;
      } else if (line.startsWith('deleted file mode')) {
        cur!.isDelete = true;
        i++;
      } else if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        const { body, next } = collectBody(lines, i + 1);
        cur!.hunks.push(buildHunk(a, body));
        i = next;
        state = 'between';
      } else {
        i++;
      }
    } else {
      if (line.startsWith('diff --git ')) {
        finish();
        startDiff(line, i);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finish();
        cur = { hasPair: true, oldPath: uniPath(line.slice(4)), newPath: uniPath(lines[i + 1]!.slice(4)), isCreate: false, isDelete: false, hunks: [] };
        state = 'header';
        i += 2;
      } else if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        const { body, next } = collectBody(lines, i + 1);
        cur!.hunks.push(buildHunk(a, body));
        i = next;
      } else {
        i++;
      }
    }
  }
  finish();
  return sections;
}

/** Apply one hunk to a file's state; d is the length delta of this section's hunks applied so far. */
function applyHunk(state: FileState, hunk: Hunk, d: number, strict: boolean, path: string): FileState {
  const lines = state.lines;
  if (hunk.o.length === 0) {
    const at = Math.min(Math.max(hunk.a + d, 0), lines.length);
    const add = hunk.parts.map((x) => (x.kind === 'add' ? x.text : ''));
    const out = [...lines.slice(0, at), ...add, ...lines.slice(at)];
    const final = at === lines.length ? !hunk.lastPlusBackslash : state.final;
    return { br: state.br, lines: out, final };
  }
  const found = firstTier(lines, hunk.o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.positions[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const add = replacementLines(lines, pos, hunk.o, hunk.parts, found.tier);
  const out = [...lines.slice(0, pos), ...add, ...lines.slice(pos + hunk.o.length)];
  const final = pos + hunk.o.length === lines.length ? !hunk.lastCtxOrPlusBackslash : state.final;
  return { br: state.br, lines: out, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => (tree: Tree): void => {
    if (s.oldPath !== null && !safe(s.oldPath)) throw new Fail('unsafe', s.oldPath);
    if (s.newPath !== null && !safe(s.newPath)) throw new Fail('unsafe', s.newPath);
    if (s.isCreate) {
      const np = s.newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let lastPlusBackslash = false;
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const x of h.parts) if (x.kind === 'add') plus.push(x.text);
        if (h.plusCount > 0) lastPlusBackslash = h.lastPlusBackslash;
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (s.isDelete) {
      const op = s.oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = s.oldPath!;
    const np = s.newPath!;
    const isMove = op !== np;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    let state = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      state = applyHunk(state, h, d, strict, op);
      d += h.parts.length - h.o.length;
    }
    const out = joinFile(state);
    if (isMove) {
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, out);
    }
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  const n = lines.length;
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.trimEnd() === '=======';
  const isEnd = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (!isSearch(lines[i]!)) {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = s + 1; j < n; j++) {
      if (isSearch(lines[j]!)) break;
      if (isSep(lines[j]!)) {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let j = sep + 1; j < n; j++) {
      if (isSearch(lines[j]!)) break;
      if (isEnd(lines[j]!)) {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const state = splitFile(before);
    const found = firstTier(state.lines, b.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const f = leadingWS(state.lines[pos]!);
    const p = leadingWS(b.oldLines[0]!);
    const add = b.newLines.map((l) => reindentLine(l, found.tier, f, p));
    const out = [...state.lines.slice(0, pos), ...add, ...state.lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, joinFile({ br: state.br, lines: out, final: state.final }));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4AChunk {
  /** '' means no anchor. */
  anchor: string;
  o: string[];
  parts: NPart[];
  /** The chunk ends with `*** End of File`: it must end at the file's last line. */
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Add File: the file's lines. */
  lines: string[];
  /** Update File: the new path, or null. */
  moveTo: string | null;
  chunks: V4AChunk[];
  /** 1-based line of the section header, for parse errors. */
  headerLine: number;
}

const isV4AHeader = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function buildV4AChunk(anchor: string, body: string[], eof: boolean): V4AChunk {
  const o: string[] = [];
  const parts: NPart[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const text = l === '' ? '' : l.slice(1);
      o.push(text);
      parts.push({ kind: 'ctx', oIndex: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else {
      parts.push({ kind: 'add', text: l.slice(1) });
    }
  }
  return { anchor, o, parts, eof };
}

function parseV4a(lines: string[]): V4ASection[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const raw: Array<{ text: string; no: number }> = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isV4AHeader(l) || l.trim() === '*** End Patch') break;
        if (blank(l) || l.startsWith('+')) {
          raw.push({ text: l, no: j + 1 });
          j++;
        } else {
          throw new Exit2(`error: parse ${j + 1}`);
        }
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      sections.push({ kind: 'add', path, lines: raw.map((r) => (r.text === '' ? '' : r.text.slice(1))), moveTo: null, chunks: [], headerLine: i + 1 });
      i = j;
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isV4AHeader(l) || l.trim() === '*** End Patch') break;
        if (blank(l)) {
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      sections.push({ kind: 'delete', path, lines: [], moveTo: null, chunks: [], headerLine: i + 1 });
      i = j;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const headerLine = i + 1;
      const raw: Array<{ text: string; no: number }> = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isV4AHeader(l) || l.trim() === '*** End Patch') break;
        raw.push({ text: l, no: j + 1 });
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.text.slice(13).trim();
        k++;
      }
      const chunks: V4AChunk[] = [];
      let cur: { anchor: string; body: string[]; eof: boolean } | null = null;
      const push = (): void => {
        if (cur !== null) {
          chunks.push(buildV4AChunk(cur.anchor, cur.body, cur.eof));
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          push();
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
        } else if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          push();
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            cur = { anchor: '', body: [], eof: false };
          }
          cur.body.push(l);
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      push();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind: 'update', path, lines: [], moveTo, chunks, headerLine });
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((s) => (tree: Tree): void => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null) {
      if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    }
    const state = splitFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== '') {
        const at = findSingleLine(state.lines, chunk.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? state.lines.length : cursor;
        const add = chunk.parts.map((x) => (x.kind === 'add' ? x.text : ''));
        state.lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        let positions = occurrences(state.lines, chunk.o, t, cursor);
        if (chunk.eof) positions = positions.filter((pos) => pos + chunk.o.length === state.lines.length);
        if (positions.length > 0) {
          found = { tier: t, pos: positions[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', s.path);
      const add = replacementLines(state.lines, found.pos, chunk.o, chunk.parts, found.tier);
      state.lines.splice(found.pos, chunk.o.length, ...add);
      cursor = found.pos + add.length;
    }
    const out = joinFile(state);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  });
}

// ---------------------------------------------------------------------------
// Running (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.finalOf(oldP) === null && tree.original(newP) === null && tree.finalOf(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
