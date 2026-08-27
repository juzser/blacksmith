// A template that names something nothing provides renders `undefined` and
// says nothing about it. That is the repo's oldest stated gap — SECURITY.md
// has carried "a template referencing something that does not exist is caught
// by e2e or not at all" since the first release — and it is not a gap anyone
// can close with `vue-tsc`: Volar needs TypeScript's classic Node compiler
// API, and this repo is on the native port, where `createProgram` is
// `undefined`. `ui/test/sfc.ts` closes it a different way, by asking Vue's own
// compiler what it had to leave for runtime, and this is the gate that reads
// the answer.
//
// e2e was never going to catch it: `shoot()` in ui/e2e/helpers.ts writes a
// screenshot, it does not compare one. A control can render wrong in all 135
// passing tests. `<Card size="sm">` did, at eight call sites, for as long as
// the file has existed — see D-258.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nth } from './helpers';
import {
  analyzeSource,
  type ComponentApi,
  callSites,
  componentApi,
  scanCallSites,
  sfcFiles,
} from './sfc';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

/** A component with one of everything, to check the call-site gate against. */
const WIDGET = `
<script setup lang="ts">
defineProps<{ label: string; tone?: string }>();
defineEmits<{ pick: [id: string]; close: [] }>();
</script>
<template>
  <div :class="tone">{{ label }}<slot /><slot name="footer" /></div>
</template>
`;

function caller(body: string): string {
  return `<script setup lang="ts">\nimport Widget from './Widget.vue';\n</script>\n<template>\n${body}\n</template>\n`;
}

const widgetApi = componentApi(WIDGET, '/app/Widget.vue');
const resolveWidget = (path: string): ComponentApi | null =>
  path === '/app/Widget.vue' ? widgetApi : null;

const callWidget = (body: string) =>
  callSites(caller(body), '/app/Page.vue', '/app', resolveWidget);

describe('analyzeSource', () => {
  it('names an identifier the template reads and the script never declares', () => {
    const report = analyzeSource(
      `<script setup lang="ts">const shown = 1;</script><template><p>{{ shown }}{{ typoed }}</p></template>`,
      'Bad.vue',
    );
    expect(report.identifiers).toEqual(['typoed']);
  });

  it('names a component the template renders and nothing imports', () => {
    const report = analyzeSource(`<template><MissingThing /></template>`, 'Bad.vue');
    expect(report.components).toEqual(['MissingThing']);
  });

  it('names a directive no import registers', () => {
    const report = analyzeSource(`<template><input v-focus /></template>`, 'Bad.vue');
    expect(report.directives).toEqual(['focus']);
  });

  it('counts a template-only import as used', () => {
    const source = `<script setup lang="ts">\nimport Lozenge from './Lozenge.vue';\n</script>\n<template><Lozenge /></template>`;
    expect(analyzeSource(source, 'Ok.vue').unusedImports).toEqual([]);
  });

  it('names an import neither the script nor the template uses', () => {
    const source = `<script setup lang="ts">\nimport Lozenge from './Lozenge.vue';\n</script>\n<template><p>nothing</p></template>`;
    expect(analyzeSource(source, 'Bad.vue').unusedImports).toEqual(['Lozenge']);
  });

  it('does not fault a component for rendering itself recursively', () => {
    const source = `<template><div><Tree v-if="false" /></div></template>`;
    expect(analyzeSource(source, '/app/Tree.vue').components).toEqual([]);
  });

  it('reports a compiler diagnostic instead of an empty all-clear', () => {
    const report = analyzeSource(`<template><div v-if></div></template>`, 'Bad.vue');
    expect(report.error).not.toBeNull();
  });
});

describe('componentApi', () => {
  it('separates required props from optional ones', () => {
    expect(widgetApi.props).toEqual(['label', 'tone']);
    expect(widgetApi.requiredProps).toEqual(['label']);
  });

  it('reads events off a Vue 3.3 defineEmits type literal', () => {
    expect(widgetApi.emits).toEqual(['close', 'pick']);
  });

  it('reads slot names, default included', () => {
    expect(widgetApi.slots).toEqual(['default', 'footer']);
    expect(widgetApi.dynamicSlots).toBe(false);
  });

  it('gives up on the slot set when a slot name is bound', () => {
    const api = componentApi(`<template><slot :name="tab.id" /></template>`, '/app/Tabs.vue');
    expect(api.dynamicSlots).toBe(true);
  });
});

describe('callSites', () => {
  it('names an attribute the called component declares no prop for', () => {
    const found = nth(callWidget(`<Widget label="x" size="sm" />`), 0);
    expect(found.unknownAttrs).toEqual(['size']);
    expect(found.tag).toBe('Widget');
    expect(found.file).toBe('Page.vue');
  });

  it('lets an ARIA, data- or HTML global attribute fall through', () => {
    expect(
      callWidget(`<Widget label="x" class="a" aria-label="b" data-id="c" title="d" />`),
    ).toEqual([]);
  });

  it('names a required prop the call site omits', () => {
    expect(nth(callWidget(`<Widget tone="calm" />`), 0).missingRequired).toEqual(['label']);
  });

  it('accepts a required prop passed as a binding', () => {
    expect(callWidget(`<Widget :label="text" />`)).toEqual([]);
  });

  it('claims nothing about an element carrying v-bind spread', () => {
    expect(callWidget(`<Widget v-bind="everything" />`)).toEqual([]);
  });

  it('names a listener the called component never emits', () => {
    expect(nth(callWidget(`<Widget label="x" @choose="run" />`), 0).unknownEvents).toEqual([
      'choose',
    ]);
  });

  it('lets a native DOM listener fall through to the root element', () => {
    expect(callWidget(`<Widget label="x" @click="run" @keydown.enter="run" />`)).toEqual([]);
  });

  it('names a slot the called component never renders', () => {
    expect(
      nth(callWidget(`<Widget label="x"><template #header>h</template></Widget>`), 0).unknownSlots,
    ).toEqual(['header']);
  });

  it('accepts a slot the called component does render', () => {
    expect(callWidget(`<Widget label="x"><template #footer>f</template></Widget>`)).toEqual([]);
  });

  it('reaches call sites nested inside a v-if branch', () => {
    const body = `<div><span v-if="ok"><Widget label="x" size="sm" /></span><em v-else /></div>`;
    expect(nth(callWidget(body), 0).unknownAttrs).toEqual(['size']);
  });

  it('says nothing about a component it cannot resolve', () => {
    const source = `<script setup lang="ts">\nimport Other from './Other.vue';\n</script>\n<template><Other whatever="1" /></template>`;
    expect(callSites(source, '/app/Page.vue', '/app', () => null)).toEqual([]);
  });
});

describe('every SFC in ui/src', () => {
  const files = sfcFiles(SRC);

  it('has files to check, so a green run means something', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('leaves nothing for Vue to resolve at runtime', () => {
    const faults = files
      .map((file) => analyzeSource(readFileSync(file, 'utf8'), file, SRC))
      .filter(
        (report) =>
          report.error !== null ||
          report.identifiers.length > 0 ||
          report.components.length > 0 ||
          report.directives.length > 0 ||
          report.unusedImports.length > 0,
      );
    expect(faults).toEqual([]);
  });

  it('passes each component only what that component declares', () => {
    expect(scanCallSites(SRC)).toEqual([]);
  });
});
