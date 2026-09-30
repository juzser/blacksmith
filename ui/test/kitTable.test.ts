// Static source-text check, same style as kitDialog.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'kit');
const TABLE = readFileSync(join(KIT, 'Table.vue'), 'utf8');

describe('kit/Table.vue', () => {
  it('imports TableColumn from the new kit/types.js, not ds/types.js', () => {
    expect(TABLE).toMatch(/import type \{ TableColumn \} from '\.\/types\.js';/);
  });

  it('declares columns/rows/rowKey/empty/clickable/bordered/compact props with their defaults', () => {
    expect(TABLE).toMatch(/columns:\s*TableColumn\[\]/);
    expect(TABLE).toMatch(/rows:\s*Array<Record<string,\s*unknown>>/);
    expect(TABLE).toMatch(/rowKey\?:\s*string/);
    expect(TABLE).toMatch(/empty\?:\s*string/);
    expect(TABLE).toMatch(/clickable\?:\s*boolean/);
    expect(TABLE).toMatch(/bordered\?:\s*boolean/);
    expect(TABLE).toMatch(/compact\?:\s*boolean/);
    const match = TABLE.match(
      /withDefaults\(\s*defineProps<\{[\s\S]*?\}>\(\),\s*\{([\s\S]*?)\}\s*,?\s*\)/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/rowKey:\s*'id'/);
    expect(match?.[1]).toMatch(/empty:\s*'No results\.'/);
    expect(match?.[1]).toMatch(/clickable:\s*false/);
    expect(match?.[1]).toMatch(/bordered:\s*true/);
    expect(match?.[1]).toMatch(/compact:\s*false/);
  });

  it('documents the compact decision citing ds-spec.md §2.3 (Row/RowList folded into Table)', () => {
    expect(TABLE).toMatch(/ds-spec\.md §2\.3/);
  });

  it('emits rowClick and exposes a scoped cell slot', () => {
    expect(TABLE).toMatch(
      /defineEmits<\{\s*rowClick:\s*\[row:\s*Record<string,\s*unknown>\];?\s*\}>/,
    );
    expect(TABLE).toMatch(/<slot name="cell" :column="c" :row="row">/);
  });

  it('applies bs-table--compact only when compact is true', () => {
    expect(TABLE).toMatch(/'bs-table--compact':\s*compact/);
  });
});
