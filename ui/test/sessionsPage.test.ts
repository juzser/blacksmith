import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'SessionsPage.vue'),
  'utf8',
);

// Task 2 (friendly role labels): every place this page renders a raw
// taxonomy role ("coder") routes through roleLabel() ("Builder") instead —
// the orphaned-agents banner, the agent node's aria-label, its IdentityChip,
// and the sr-only table's agent column all name a role in plain text or as a
// chip label, so all four need the friendly word.
describe('SessionsPage.vue — role labels', () => {
  it('imports roleLabel', () => {
    expect(SFC).toMatch(/from '\.\.\/lib\/roleLabels\.js'/);
  });

  it('labels the orphaned-working-agents banner', () => {
    expect(SFC).toMatch(/roleLabel\(a\.agentRole\)/);
  });

  it('labels the agent node aria-label', () => {
    expect(SFC).toMatch(/roleLabel\(node\.agent\.agentRole\)/);
  });

  it('labels the agent node IdentityChip and keeps the raw role · tier as a tooltip', () => {
    expect(SFC).toMatch(
      /:label="`\$\{roleLabel\(node\.agent\.agentRole\)\} · \$\{node\.agent\.modelTier\}`"/,
    );
    expect(SFC).toMatch(
      /<IdentityChip[^>]*:title="`\$\{node\.agent\.agentRole\} · \$\{node\.agent\.modelTier\}`"/s,
    );
  });

  it('labels the sr-only table agent column', () => {
    expect(SFC).toContain('{{ roleLabel(a.agentRole) }} · {{ a.modelTier }}');
  });
});

// Touch-target sweep: fit-to-view shrinks native-sized nodes below --bs-touch
// on a 390px canvas. Raising minZoom to 1 at phone width (same breakpoint as
// useViewport's isPhoneWidth) keeps fitView() from scaling nodes down; the
// pane pans instead. Desktop keeps Vue Flow's own 0.5 default unchanged.
describe('SessionsPage.vue — mobile minZoom floor', () => {
  it('reads isPhoneWidth from the shared viewport composable', () => {
    expect(SFC).toMatch(/from '\.\.\/composables\/useViewport\.js'/);
    expect(SFC).toMatch(/const \{ isPhoneWidth \} = useViewport\(\);/);
  });

  it('computes minZoom as 1 on phone, 0.5 (Vue Flow default) otherwise', () => {
    expect(SFC).toMatch(/const minZoom = computed\(\(\) => \(isPhoneWidth\.value \? 1 : 0\.5\)\);/);
  });

  it('binds minZoom onto the VueFlow canvas', () => {
    expect(SFC).toMatch(/<VueFlow[\s\S]{0,200}:min-zoom="minZoom"/);
  });
});
