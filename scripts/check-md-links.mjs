#!/usr/bin/env node
// Every relative link in a tracked .md file must resolve to a tracked file or
// directory, and a #anchor must match a heading slug (GitHub style) in the target
// .md file. Query strings are ignored; external links are skipped; fenced and
// inline code are not scanned. Usage: check-md-links.mjs [repo-root]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const files = new Set(tracked);
const dirs = new Set();
for (const f of tracked) {
  for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
}

const strip = (t) => t.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '');
const slugCache = new Map();
function slugs(f) {
  if (slugCache.has(f)) return slugCache.get(f);
  const set = new Set();
  const seen = new Map();
  let text = '';
  try {
    text = strip(readFileSync(path.join(root, f), 'utf8'));
  } catch {}
  for (const m of text.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    const base = m[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\- _]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    set.add(n === 0 ? base : `${base}-${n}`);
  }
  slugCache.set(f, set);
  return set;
}

let bad = 0;
for (const f of tracked.filter((p) => p.endsWith('.md'))) {
  let text;
  try {
    text = readFileSync(path.join(root, f), 'utf8');
  } catch {
    continue;
  }
  text = text.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '').replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = m[1];
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const rel = decodeURIComponent(target.split(/[?#]/)[0]);
    const anchor = target.includes('#') ? decodeURIComponent(target.split('#')[1].split('?')[0]).toLowerCase() : '';
    if (!rel) {
      if (anchor && !slugs(f).has(anchor)) {
        console.log(`FAIL ${f}: broken anchor (${target})`);
        bad++;
      }
      continue;
    }
    const resolved = rel.startsWith('/')
      ? path.posix.normalize(rel.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(f), rel));
    const clean = resolved.replace(/\/$/, '') || '.';
    if (clean === '.' || files.has(clean) || dirs.has(clean)) {
      if (anchor && files.has(clean) && clean.endsWith('.md') && !slugs(clean).has(anchor)) {
        console.log(`FAIL ${f}: broken anchor (${target})`);
        bad++;
      }
      continue;
    }
    console.log(`FAIL ${f}: broken link (${target})`);
    bad++;
  }
}
if (bad) process.exit(1);
console.log(`OK   markdown links resolve (${tracked.filter((p) => p.endsWith('.md')).length} files)`);
