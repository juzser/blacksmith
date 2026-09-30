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
// from ui/src/styles/ds-tokens.css, never a second hardcoded copy of the
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
//   9. Shell liveness round: SidebarNav.vue gained arrival badges
//      (ui/src/lib/navBadges.ts). Two new pairings — the expanded pill's
//      --ds-text-on-bold count on --ds-info-bold, which is real TEXT and so
//      takes the 4.5:1 floor; and the collapsed rail's dot, --ds-info-bold as
//      a UI graphic against --ds-surface-sunken. The dot's ring is painted in
//      that same sunken surface precisely so this is the pair that applies:
//      the dot can sit on an active item, whose --ds-primary-subtle tint puts
//      info-bold at 2.84:1 in dark theme, under the floor. --ds-info-bold is
//      also why the badge is not --ds-primary: identical in light theme, but
//      --ds-primary lightens in dark and takes white text to 3.68:1.
//      The same round put the factory-pulse readout in the topbar
//      (--ds-text-subtle on --ds-surface, App.vue). It is small text that
//      reports a real fact, so it is measured at the text floor rather than
//      waved through as decoration.
//
// Exit 0 = every pair clears its floor. Exit 1 otherwise (prints the
// failing pair so it's actionable, not just "gate failed").
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const TOKENS_PATH = path.join(REPO_ROOT, 'ui/src/styles/ds-tokens.css');
// DS0 (ds-spec.md §0/§5): both kits are checked in this PR — old pages still
// import ds-tokens.css until DS9 drops it, so this file gains a second,
// independent parser/check-list for the new bs- palette rather than
// replacing the ds- one.
const BS_TOKENS_PATH = path.join(REPO_ROOT, 'ui/src/styles/bs-tokens.css');

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

function parseBsThemeBlocks(css) {
  // bs-tokens.css keys its dark palette on `:root.dark` — the class
  // useTheme.ts actually toggles on <html>, the same mechanism ds-tokens.css
  // uses (`.dark {}`, no OS media-query fallback, no `data-theme` attribute;
  // see that file's own header comment). One block, single source of truth.
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

const css = readFileSync(TOKENS_PATH, 'utf8');
const { light, dark } = parseThemeBlocks(css);
const bsCss = readFileSync(BS_TOKENS_PATH, 'utf8');
const { light: bsLight, dark: bsDark } = parseBsThemeBlocks(bsCss);

const UI_GRAPHIC_FLOOR = 3.0;
const TEXT_FLOOR = 4.5;
let failures = 0;
const rows = [];

function check(label, fgKey, bgKey, theme, tokens, floor = UI_GRAPHIC_FLOOR, kind = 'UI graphic', prefix = 'ds') {
  const fg = tokens[fgKey];
  const bg = tokens[bgKey];
  if (!fg || !bg) {
    failures += 1;
    rows.push(`FAIL ${label} (${theme}): token not found (--${prefix}-${fgKey} or --${prefix}-${bgKey})`);
    return;
  }
  const ratio = contrast(fg, bg);
  const pass = ratio >= floor;
  if (!pass) failures += 1;
  rows.push(
    `${pass ? 'PASS' : 'FAIL'} ${label} (${theme}): --${prefix}-${fgKey} ${fg} on --${prefix}-${bgKey} ${bg} = ${ratio.toFixed(2)}:1 (need ${floor}:1 ${kind})`,
  );
}

function checkBs(label, fgKey, bgKey, theme, tokens, floor = UI_GRAPHIC_FLOOR, kind = 'UI graphic') {
  check(label, fgKey, bgKey, theme, tokens, floor, kind, 'bs');
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
  check('Nav badge count', 'text-on-bold', 'info-bold', theme, tokens, TEXT_FLOOR, 'AA normal text');
  check('Nav badge dot (collapsed)', 'info-bold', 'surface-sunken', theme, tokens);
  check('Topbar factory pulse', 'text-subtle', 'surface', theme, tokens, TEXT_FLOOR, 'AA normal text');
}

// BS kit (ds-spec.md §1.3's measured-contrast table, DS0 scope). Additive:
// the ds- loop above is untouched, old pages still use that kit until DS9.
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
