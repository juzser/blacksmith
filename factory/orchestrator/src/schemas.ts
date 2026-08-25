import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';

// ajv-formats ships a .d.ts written as an ES module (`export default`) but its
// package.json has no "type": "module", so under NodeNext resolution its
// declared type is the whole CJS module namespace, not the callable plugin
// function it actually is at runtime (verified: module.exports is the
// function itself). Narrow it back to the callable shape here, once.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

import { SmithError } from './errors.js';
import { SCHEMA_DIR } from './paths.js';
import { type Taxonomy, validateTag } from './taxonomy.js';

export class SchemaError extends SmithError {}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult = { valid: true } | { valid: false; errors: ValidationIssue[] };

interface TaxonomyPointer {
  segments: string[];
  dimension: string;
  /** Where in the schema document the annotation sits, as a JSON pointer.
   * Only the reachability guard in `compileSchemas` reads it. */
  schemaPath: string;
}

export interface CompiledSchema {
  name: string;
  validate: ValidateFunction;
  taxonomyPointers: TaxonomyPointer[];
}

export type CompiledSchemaSet = Map<string, CompiledSchema>;

function schemaNameFromFile(fileName: string): string {
  // "task-spec.schema.json" -> "task-spec"
  return fileName.replace(/\.schema\.json$/, '');
}

/**
 * Recursively collect every `x-taxonomy`-annotated field path in a JSON Schema.
 * A `[]` segment stands for "every element of the array here" — see
 * `resolveAtPath`, which is the half that has to know how to walk it.
 */
function collectTaxonomyPointers(
  node: unknown,
  segments: string[] = [],
  schemaPath = '',
): TaxonomyPointer[] {
  if (!node || typeof node !== 'object') return [];
  const found: TaxonomyPointer[] = [];
  const obj = node as Record<string, unknown>;

  const properties = obj.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, propSchema] of Object.entries(properties as Record<string, unknown>)) {
      const childSegments = [...segments, key];
      const childPath = `${schemaPath}/properties/${key}`;
      const prop = propSchema as Record<string, unknown>;
      if (typeof prop['x-taxonomy'] === 'string') {
        found.push({
          segments: childSegments,
          dimension: prop['x-taxonomy'],
          schemaPath: childPath,
        });
      }
      found.push(...collectTaxonomyPointers(prop, childSegments, childPath));
    }
  }

  const items = obj.items;
  if (items && typeof items === 'object') {
    const itemSegments = [...segments, '[]'];
    const itemPath = `${schemaPath}/items`;
    // An array of tag strings has no property to hang the annotation on, so
    // it goes on `items` itself. Only entries of `properties` were read for
    // one, which meant that whole shape was invisible (D-194).
    const item = items as Record<string, unknown>;
    if (typeof item['x-taxonomy'] === 'string') {
      found.push({ segments: itemSegments, dimension: item['x-taxonomy'], schemaPath: itemPath });
    }
    found.push(...collectTaxonomyPointers(items, itemSegments, itemPath));
  }

  return found;
}

/**
 * Every `x-taxonomy` in the document, wherever it sits, as JSON pointers.
 * Deliberately keyword-blind: it walks the raw JSON, so it sees the ones
 * `collectTaxonomyPointers` walks past as well as the ones it collects. The
 * difference between the two lists is the hole.
 */
function annotationPathsAnywhere(node: unknown, schemaPath = ''): string[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => annotationPathsAnywhere(child, `${schemaPath}/${i}`));
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'x-taxonomy' && typeof value === 'string') {
      found.push(schemaPath);
      continue;
    }
    found.push(...annotationPathsAnywhere(value, `${schemaPath}/${key}`));
  }
  return found;
}

interface Resolved {
  /** The concrete path, array indices filled in, as ajv's instancePath spells it. */
  path: string[];
  value: unknown;
}

/**
 * Every value a pointer names. One for a plain field; one per element for a
 * `[]` segment, which is why this returns a list rather than a value — a
 * pointer under an array is a question about each element, and the answer has
 * to say which one.
 */
function resolveAtPath(
  data: unknown,
  segments: readonly string[],
  prefix: string[] = [],
): Resolved[] {
  const [segment, ...rest] = segments;
  if (segment === undefined) return [{ path: prefix, value: data }];

  if (segment === '[]') {
    if (!Array.isArray(data)) return [];
    return data.flatMap((element, i) => resolveAtPath(element, rest, [...prefix, String(i)]));
  }

  if (data === null || data === undefined || typeof data !== 'object') return [];
  return resolveAtPath((data as Record<string, unknown>)[segment], rest, [...prefix, segment]);
}

export function loadSchemaFiles(dir: string = SCHEMA_DIR): Map<string, Record<string, unknown>> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));
  const schemas = new Map<string, Record<string, unknown>>();
  for (const file of files) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    schemas.set(schemaNameFromFile(file), JSON.parse(text) as Record<string, unknown>);
  }
  return schemas;
}

export function compileSchemas(_taxonomy: Taxonomy, dir: string = SCHEMA_DIR): CompiledSchemaSet {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const raw = loadSchemaFiles(dir);
  const compiled: CompiledSchemaSet = new Map();
  for (const [name, schema] of raw) {
    const taxonomyPointers = collectTaxonomyPointers(schema);
    assertEveryAnnotationReachable(name, schema, taxonomyPointers);
    compiled.set(name, {
      name,
      validate: ajv.compile(schema),
      taxonomyPointers,
    });
  }
  return compiled;
}

/**
 * Refuse a schema that annotates a field the pointer walker cannot reach.
 *
 * The walker reads `properties` and `items`. A subschema can also live under
 * `$defs` behind a `$ref`, in a `oneOf`/`anyOf`/`allOf` branch, under
 * `patternProperties` -- and mcp-manifest.schema.json already uses four of
 * those. An annotation there used to be collected by nobody and reported by
 * nobody: the record validated, the unknown tag went in, and the field simply
 * stopped being governed by the taxonomy. Nothing distinguishes that from a
 * field nobody annotated.
 *
 * The fix is the error, not reference resolution. Resolving `$ref` means
 * owning a second schema engine -- cycles, remote ids, `$dynamicRef` -- to
 * serve a shape no committed schema uses. Refusing at compile time costs one
 * comparison and tells the schema author the one thing they need to know, at
 * the moment they need it, instead of leaving them a validator that silently
 * agrees with everything.
 */
function assertEveryAnnotationReachable(
  name: string,
  schema: Record<string, unknown>,
  pointers: readonly TaxonomyPointer[],
): void {
  const reachable = new Set(pointers.map((p) => p.schemaPath));
  const unreachable = annotationPathsAnywhere(schema).filter((p) => !reachable.has(p));
  if (unreachable.length === 0) return;
  throw new SchemaError(
    'schema.unreachable-taxonomy',
    `Schema "${name}" annotates ${unreachable.length} field(s) with x-taxonomy where the ` +
      `pointer walker cannot see them: ${unreachable.join(', ')}. It reads \`properties\` and ` +
      '`items` only, so an annotation under `$defs`, `$ref`, `oneOf`, `anyOf`, `allOf` or ' +
      '`patternProperties` would never be checked and the field would go ungoverned. Move it ' +
      'onto the property (or onto `items`) that carries the value.',
    { schema: name, paths: unreachable },
  );
}

function ajvErrorToIssue(err: ErrorObject): ValidationIssue {
  return { path: err.instancePath || '/', message: `${err.instancePath} ${err.message}`.trim() };
}

/**
 * Validate a record against a compiled schema by name, then resolve every
 * x-taxonomy annotated field against the taxonomy so a schema-valid record
 * with an unknown taxonomy value still fails.
 */
export function validateRecord(
  schemas: CompiledSchemaSet,
  taxonomy: Taxonomy,
  schemaName: string,
  record: unknown,
): ValidationResult {
  const compiled = schemas.get(schemaName);
  if (!compiled) {
    throw new SchemaError('schema.unknown-name', `Unknown schema "${schemaName}".`, {
      schemaName,
      known: [...schemas.keys()],
    });
  }

  const errors: ValidationIssue[] = [];

  const schemaValid = compiled.validate(record);
  if (!schemaValid) {
    for (const err of compiled.validate.errors ?? []) {
      errors.push(ajvErrorToIssue(err));
    }
  }

  for (const pointer of compiled.taxonomyPointers) {
    for (const hit of resolveAtPath(record, pointer.segments)) {
      if (hit.value === undefined) continue; // absence is the schema's job, not ours
      const pathStr = `/${hit.path.join('/')}`;
      try {
        validateTag(taxonomy, pointer.dimension, String(hit.value));
      } catch (err) {
        errors.push({ path: pathStr, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true };
}
