#!/usr/bin/env node
// Phase 6b fix-round (uiux S2 #1, #4 + code review #14): a small, repo-
// specific contrast gate — pulled forward from the four generic design-
// system gate scripts (none wired yet, ui/docs/DESIGN.md's "Gates wired"
// table) because it would have auto-caught #1 (IdentityChip text contrast)
// and #4 (Flow edge stroke contrast) before they shipped, back when the
// dashboard still ran the old `ds-` kit. DS9 part B retired that kit
// (ui/src/styles/ds-tokens.css, ui/src/components/ds/) along with the
// pages it checked (IdentityChip/FlowPage/LiveStatus), so the ds- side of
// this gate is gone with them — only the bs- kit's pairs below remain.
//
// Same WCAG 2.2 relative-luminance formula as
// knowledge/design-system/pack/scripts/contrast.py (re-implemented here in
// JS, not shelled out to Python, so this repo's gate has no runtime
// dependency outside its own toolchain — the READING is still verbatim
// from ui/src/styles/bs-tokens.css, never a second hardcoded copy of the
// hex values, so this script can't silently drift from the real tokens).
//
// Exit 0 = every pair clears its floor. Exit 1 otherwise (prints the
// failing pair so it's actionable, not just "gate failed").
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const BS_TOKENS_PATH = path.join(REPO_ROOT, 'ui/src/styles/bs-tokens.css');

function parseBsThemeBlocks(css) {
  // bs-tokens.css keys its dark palette on `:root.dark` — the class
  // useTheme.ts actually toggles on <html>, the same mechanism the old
  // kit's ds-tokens.css used (`.dark {}`, no OS media-query fallback, no
  // `data-theme` attribute). One block, single source of truth.
  function parseBlock(blockRe) {
    const m = blockRe.exec(css);
    if (!m) return {};
    const raw = {};
    const varRe = /--bs-([\w-]+):\s*(#[0-9a-fA-F]{3,8}|var\(\s*--bs-[\w-]+\s*\))\s*;/g;
    let vm = varRe.exec(m[1]);
    while (vm) {
      raw[vm[1]] = vm[2];
      vm = varRe.exec(m[1]);
    }
    return raw;
  }

  // Some tokens (--bs-tooltip-*, --bs-link-*) are declared as `var(--bs-x)`
  // indirection rather than a literal hex (ds-spec.md §1.2's own token
  // table) — resolve exactly one level of that against the same theme's map.
  function resolve(raw) {
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const varMatch = value.match(/^var\(\s*--bs-([\w-]+)\s*\)$/);
      out[key] = varMatch ? raw[varMatch[1]] : value;
    }
    return out;
  }

  const lightRaw = parseBlock(/:root\s*\{([^}]*)\}/s);
  const darkRaw = parseBlock(/:root\.dark\s*\{([^}]*)\}/s);
  return { light: resolve(lightRaw), dark: resolve(darkRaw) };
}

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const int = Number.parseInt(h.slice(0, 6), 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function relLum([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [rl, gl, bl] = [r, g, b].map(lin);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrast(fgHex, bgHex) {
  const l1 = relLum(hexToRgb(fgHex));
  const l2 = relLum(hexToRgb(bgHex));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const bsCss = readFileSync(BS_TOKENS_PATH, 'utf8');
const { light: bsLight, dark: bsDark } = parseBsThemeBlocks(bsCss);

const UI_GRAPHIC_FLOOR = 3.0;
const TEXT_FLOOR = 4.5;
let failures = 0;
const rows = [];

function checkBs(label, fgKey, bgKey, theme, tokens, floor = UI_GRAPHIC_FLOOR, kind = 'UI graphic') {
  const fg = tokens[fgKey];
  const bg = tokens[bgKey];
  if (!fg || !bg) {
    failures += 1;
    rows.push(`FAIL ${label} (${theme}): token not found (--bs-${fgKey} or --bs-${bgKey})`);
    return;
  }
  const ratio = contrast(fg, bg);
  const pass = ratio >= floor;
  if (!pass) failures += 1;
  rows.push(
    `${pass ? 'PASS' : 'FAIL'} ${label} (${theme}): --bs-${fgKey} ${fg} on --bs-${bgKey} ${bg} = ${ratio.toFixed(2)}:1 (need ${floor}:1 ${kind})`,
  );
}

// BS kit (ds-spec.md §1.3's measured-contrast table, DS0 scope).
// 'info' is not one of §1.1's 7 status tones — it exists only because
// Banner's tone prop is info|warning|danger (§2.1) and reuses progress's
// blue values (bs-tokens.css's own comment on --bs-tone-info-text explains
// why). Checked here anyway: a reused value still needs to pass on its new
// name, not just be assumed to since the pair it copies already does.
// 'neutral' (DS0 batch A) is Tag's 8th tone (§2.1) — another gap in §1.1's
// 7-tone table, aliased in bs-tokens.css to --bs-text-subtle/
// --bs-surface-sunken rather than a new hex; parseBsThemeBlocks already
// resolves one level of var() indirection, so it measures the same as
// those two tokens' own already-passing pair.
const TONES = ['done', 'review', 'progress', 'todo', 'blocked', 'danger', 'warning', 'info', 'neutral'];
const EVENTS = ['prompt', 'dispatch', 'returned', 'finding', 'gate', 'merge', 'error', 'feedback', 'system'];

for (const [theme, tokens] of [
  ['light', bsLight],
  ['dark', bsDark],
]) {
  checkBs('Text / surface', 'text', 'surface', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Text-subtle / surface', 'text-subtle', 'surface', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Text-subtlest / surface', 'text-subtlest', 'surface', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Text-subtlest / surface-raised', 'text-subtlest', 'surface-raised', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Text-subtlest / surface-sunken', 'text-subtlest', 'surface-sunken', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Text / surface-raised', 'text', 'surface-raised', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Text / surface-selected (active nav, selected chip)', 'text', 'surface-selected', theme, tokens, TEXT_FLOOR, 'AA normal text');
  // Accent stays only on the primary button, the unread dot, progress fills
  // and the Prompt tint (§1.9) — the unread-dot/progress-fill use is a UI
  // graphic, not text (button-label text is the next check, at 4.5:1).
  checkBs('Accent / surface (unread dot, progress fill)', 'accent', 'surface', theme, tokens);
  checkBs('Text-on-accent / accent (button label)', 'text-on-accent', 'accent', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Focus ring / surface', 'focus-ring', 'surface', theme, tokens);

  for (const tone of TONES) {
    checkBs(`${tone} text / ${tone}-subtle`, `tone-${tone}-text`, `tone-${tone}-subtle`, theme, tokens, TEXT_FLOOR, 'AA normal text');
  }

  for (const kind of EVENTS) {
    checkBs(`Event ${kind} text / subtle`, `event-${kind}-text`, `event-${kind}-subtle`, theme, tokens, TEXT_FLOOR, 'AA normal text');
  }

  // Event stripe colour (each kind's -text token used as a 4px UI stripe,
  // not as text) against the card it sits on.
  for (const kind of EVENTS) {
    checkBs(`Event ${kind} stripe / surface-raised`, `event-${kind}-text`, 'surface-raised', theme, tokens);
  }

  checkBs('Text / prompt tint (Prompt row)', 'text', 'event-prompt-subtle', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Text-subtle / prompt tint (Prompt row meta)', 'text-subtle', 'event-prompt-subtle', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Link text / surface-sunken', 'link-text', 'surface-sunken', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Tooltip text / tooltip bg', 'tooltip-text', 'tooltip-bg', theme, tokens, TEXT_FLOOR, 'AA normal text');
  checkBs('Icon in IconButton (text-subtle) / surface', 'text-subtle', 'surface', theme, tokens);

  // §0 pairs named but not yet checked (review finding S3-2). None of these
  // three components exist yet — DS0 ships primitives only, no page wires
  // kit/ in (ds0-review.md) — so the token each will use is not yet fixed
  // by a call site; picked here from the kit's own already-documented usage
  // rules so the gate exists before the component does, not after:
  //   - LiveIndicator dot vs topbar: topbar sits on --bs-surface; accent is
  //     the token bs-tokens.css's own comment names for "the unread dot",
  //     the closest existing precedent for a live/active topbar dot.
  //   - RoadmapSwimlane now-line/pulsing dot: spec text calls it "red"
  //     (ds-spec.md line ~960) — --bs-tone-danger-text is the kit's only
  //     red. Canvas background is --bs-surface-sunken, same as the old
  //     kit's Flow/Roadmap canvas pairing this replaces.
  //   - Kanban assignee Chip text vs its tint: Chip.vue's own hover state
  //     is the only "tint" background an assignee chip has today
  //     (`.bs-chip--assignee:hover`: --bs-text on --bs-surface-sunken).
  checkBs('LiveIndicator dot / topbar surface', 'accent', 'surface', theme, tokens);
  checkBs('Roadmap now-line / timeline canvas', 'tone-danger-text', 'surface-sunken', theme, tokens);
  checkBs('Kanban assignee chip text / tint', 'text', 'surface-sunken', theme, tokens, TEXT_FLOOR, 'AA normal text');
}

console.log(rows.join('\n'));
console.log(`\n${rows.length} pairs checked, ${failures} failure(s).`);
process.exit(failures > 0 ? 1 : 0);
