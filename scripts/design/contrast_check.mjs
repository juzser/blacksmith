#!/usr/bin/env node
// Phase 6b fix-round (uiux S2 #1, #4 + code review #14): a small, repo-
// specific contrast gate — pulled forward from the four generic design-
// system gate scripts (none wired yet, ui/docs/DESIGN.md's "Gates wired"
// table) because it would have auto-caught both #1 (IdentityChip text
// contrast) and #4 (Flow edge stroke contrast) before they shipped.
//
// Same WCAG 2.2 relative-luminance formula as
// knowledge/design-system/pack/scripts/contrast.py (re-implemented here in
// JS, not shelled out to Python, so this repo's gate has no runtime
// dependency outside its own toolchain — the READING is still verbatim
// from ui/src/styles/hds-tokens.css, never a second hardcoded copy of the
// hex values, so this script can't silently drift from the real tokens).
//
// Checks:
//   1. IdentityChip.vue: each of the 8 --ds-chart-N tokens, used ONLY as a
//      border/dot colour (a UI graphic, 3:1 floor) against --ds-surface,
//      in both themes.
//   2. FlowPage.vue: --ds-text-subtlest (the edge stroke colour) against
//      --ds-surface-sunken (the canvas background), a UI graphic, 3:1
//      floor, in both themes.
//   3. Operator directive 1 (Phase 6b round 3): FlowPage.vue's new
//      .flow-node__live-dot (running-task pulsing indicator) — --ds-info-
//      bold as a UI graphic against --ds-surface-sunken, both themes.
//      Not the identity-accent chart palette (it's the existing semantic
//      "info" tone already used for the live node border), included here
//      because it's a new colour-against-canvas pairing this round.
//   4. Phase 6b round 4: OverviewPage.vue's Live-agents compact grid reuses
//      the same --ds-info-bold pulsing-dot pattern, but against
//      --ds-surface-raised (a Card's own background), not
//      --ds-surface-sunken (Flow's canvas) — a new background pairing.
//   5. Phase 6b round 5: OverviewPage.vue's "Needs you" Highlight switched
//      from tint="amber" to tint="lilac" (--ds-discovery-bold background,
//      --ds-text-on-bold eyebrow/title text) — real body TEXT, not a UI
//      graphic, so this one check uses the 4.5:1 AA normal-text floor
//      instead of the 3:1 UI-graphics floor the rest of this file checks.
//   6. Phase 6b round 7: LiveStatus.vue's freshness dot — three new
//      semantic colours as UI graphics against --ds-surface (the page
//      background, since the indicator sits in the PageHeader's actions
//      slot, not on a Card or a canvas): success-bold (live),
//      warning-bold (lagging), danger-bold (stale). Colour is never the
//      only channel there (the state word is in the adjacent label), but
//      the dot still has to be perceivable on its own.
//      RoadmapPage.vue's new VueFlow canvas needs no new pair: its edge
//      stroke and background are the exact --ds-text-subtlest on
//      --ds-surface-sunken pairing check 2 already covers.
//   7. Phase 6b round 8: .roadmap-node--live's border and its new pulsing
//      ring are --ds-info-bold. The OUTWARD side (ring over the canvas) is
//      already check 3's --ds-info-bold on --ds-surface-sunken, but the
//      INWARD side — that same border against the node's own --ds-surface —
//      has never been measured, on Roadmap or on Flow (.flow-node--live has
//      carried it since round 3). Added here because round 8 makes that
//      border the static, reduced-motion-safe half of a state signal, so it
//      has to be perceivable on its own rather than propped up by the pulse.
//   8. Phase 6b round 11: FlowPage.vue's node moved onto --ds-surface-raised
//      and gained a mono task-id line, and its wave band became a label node
//      sitting directly on --ds-surface-sunken. Checks 2 and 4 cover those
//      same token pairs only at the 3:1 UI-graphics floor, which is not the
//      floor that applies to text — so all three are re-checked here at
//      4.5:1. They pass, but that is a measurement, not an assumption.
//
// Exit 0 = every pair clears its floor. Exit 1 otherwise (prints the
// failing pair so it's actionable, not just "gate failed").
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const TOKENS_PATH = path.join(REPO_ROOT, 'ui/src/styles/hds-tokens.css');

function parseThemeBlocks(css) {
  // ":root { ... }" = light theme; ".dark { ... }" = dark theme. Chart
  // tokens live in a ":root,\n.dark { ... }" shared block (same values both
  // themes) — parsed once and reused for both theme lookups below.
  const light = {};
  const dark = {};
  const shared = {};

  const blockRe = /(:root(?:,\s*\.dark)?|\.dark)\s*\{([^}]*)\}/gs;
  let m = blockRe.exec(css);
  while (m) {
    const selector = m[1];
    const body = m[2];
    const varRe = /--ds-([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g;
    const target = selector.includes(',') ? shared : selector === '.dark' ? dark : light;
    let vm = varRe.exec(body);
    while (vm) {
      target[vm[1]] = vm[2];
      vm = varRe.exec(body);
    }
    m = blockRe.exec(css);
  }
  return {
    light: { ...shared, ...light },
    dark: { ...shared, ...dark },
  };
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

const css = readFileSync(TOKENS_PATH, 'utf8');
const { light, dark } = parseThemeBlocks(css);

const UI_GRAPHIC_FLOOR = 3.0;
const TEXT_FLOOR = 4.5;
let failures = 0;
const rows = [];

function check(label, fgKey, bgKey, theme, tokens, floor = UI_GRAPHIC_FLOOR, kind = 'UI graphic') {
  const fg = tokens[fgKey];
  const bg = tokens[bgKey];
  if (!fg || !bg) {
    failures += 1;
    rows.push(`FAIL ${label} (${theme}): token not found (--ds-${fgKey} or --ds-${bgKey})`);
    return;
  }
  const ratio = contrast(fg, bg);
  const pass = ratio >= floor;
  if (!pass) failures += 1;
  rows.push(
    `${pass ? 'PASS' : 'FAIL'} ${label} (${theme}): --ds-${fgKey} ${fg} on --ds-${bgKey} ${bg} = ${ratio.toFixed(2)}:1 (need ${floor}:1 ${kind})`,
  );
}

for (const [theme, tokens] of [
  ['light', light],
  ['dark', dark],
]) {
  for (let i = 1; i <= 8; i++) {
    check(`IdentityChip slot ${i} border/dot`, `chart-${i}`, 'surface', theme, tokens);
  }
  check('Flow edge stroke', 'text-subtlest', 'surface-sunken', theme, tokens);
  check('Flow live-indicator dot', 'info-bold', 'surface-sunken', theme, tokens);
  // Round 11: the Flow node moved onto --ds-surface-raised and gained a mono
  // task-id line, and the wave band became a label node sitting directly on
  // the canvas. All three are TEXT, so 3:1 is not the floor that applies —
  // --ds-text-subtlest passes both backgrounds at 4.5:1, but only because it
  // was measured, not assumed.
  check('Flow node task id', 'text-subtlest', 'surface-raised', theme, tokens, TEXT_FLOOR, 'AA normal text');
  check('Flow wave label', 'text-subtle', 'surface-sunken', theme, tokens, TEXT_FLOOR, 'AA normal text');
  check('Flow wave label count', 'text-subtlest', 'surface-sunken', theme, tokens, TEXT_FLOOR, 'AA normal text');
  check('Overview live-agent dot', 'info-bold', 'surface-raised', theme, tokens);
  // Round 9: the dot now has three states (lib/liveness.ts agentActivity()),
  // and the two non-default ones carry meaning by colour, so both need the
  // 3:1 UI-graphic floor against the card they sit on.
  check('Overview live-agent dot — stalled', 'warning-bold', 'surface-raised', theme, tokens);
  check('Overview live-agent dot — unknown', 'text-subtlest', 'surface-raised', theme, tokens);
  check('Highlight lilac tint text', 'text-on-bold', 'discovery-bold', theme, tokens, TEXT_FLOOR, 'AA normal text');
  check('LiveStatus dot — live', 'success-bold', 'surface', theme, tokens);
  check('LiveStatus dot — lagging', 'warning-bold', 'surface', theme, tokens);
  check('LiveStatus dot — stale', 'danger-bold', 'surface', theme, tokens);
  check('Live node border/ring (inward)', 'info-bold', 'surface', theme, tokens);
}

console.log(rows.join('\n'));
console.log(`\n${rows.length} pairs checked, ${failures} failure(s).`);
process.exit(failures > 0 ? 1 : 0);
