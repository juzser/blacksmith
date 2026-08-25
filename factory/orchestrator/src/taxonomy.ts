import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { SmithError } from './errors.js';
import { TAXONOMY_PATH } from './paths.js';

export class TaxonomyError extends SmithError {}

export interface Taxonomy {
  version: number;
  /** Flat controlled-vocabulary dimensions: dimension name -> allowed values. */
  dimensions: Record<string, string[]>;
  /** The two-level `error` dimension: group -> allowed classes. */
  errorGroups: Record<string, string[]>;
  /** record type -> list of required field names (§8 "Dimension rules"). */
  requiredDimensions: Record<string, string[]>;
}

const NON_DIMENSION_KEYS = new Set(['version', 'rules', 'error']);

// Fields required on a record that are references/collections, not taxonomy
// tags themselves — presence (non-empty) is enough, no dimension lookup.
// `model` (P9-23) is required but deliberately open: model ids turn over
// monthly, and a closed dimension would either reject next month's model or
// — the likelier outcome — get the field quietly dropped from dispatches
// instead of the taxonomy being bumped. Presence is what the asymmetry
// check needs; the exact value is only ever compared against another value.
const PRESENCE_ONLY_FIELDS = new Set(['task_ref', 'provenance_event_ids', 'model']);

/** The `error` dimension is validated as a `group.class` pair, not a flat tag. */
const ERROR_CLASS_FIELD = 'error';

export function parseTaxonomy(yamlText: string): Taxonomy {
  const doc = parseYaml(yamlText) as Record<string, unknown>;
  if (!doc || typeof doc !== 'object') {
    throw new TaxonomyError(
      'taxonomy.invalid-document',
      'Taxonomy YAML did not parse to a mapping.',
    );
  }

  const version = doc.version;
  if (typeof version !== 'number') {
    throw new TaxonomyError(
      'taxonomy.invalid-document',
      'Taxonomy is missing a numeric `version`.',
    );
  }

  const errorNode = doc.error;
  if (!errorNode || typeof errorNode !== 'object') {
    throw new TaxonomyError(
      'taxonomy.invalid-document',
      'Taxonomy is missing the `error` group block.',
    );
  }
  const errorGroups: Record<string, string[]> = {};
  for (const [group, classes] of Object.entries(errorNode as Record<string, unknown>)) {
    if (!Array.isArray(classes)) {
      throw new TaxonomyError(
        'taxonomy.invalid-document',
        `error group "${group}" must be an array of classes.`,
      );
    }
    errorGroups[group] = classes.map(String);
  }

  const dimensions: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (NON_DIMENSION_KEYS.has(key)) continue;
    if (!Array.isArray(value)) continue;
    dimensions[key] = value.map(String);
  }

  const rulesNode = doc.rules as { required_dimensions?: Record<string, string[]> } | undefined;
  const requiredDimensions = rulesNode?.required_dimensions ?? {};
  if (Object.keys(requiredDimensions).length === 0) {
    throw new TaxonomyError(
      'taxonomy.invalid-document',
      'Taxonomy is missing rules.required_dimensions.',
    );
  }

  return { version, dimensions, errorGroups, requiredDimensions };
}

export function loadTaxonomy(filePath: string = TAXONOMY_PATH): Taxonomy {
  const text = readFileSync(filePath, 'utf8');
  return parseTaxonomy(text);
}

/** Validate a single tag value against one taxonomy dimension. Never silently passes. */
export function validateTag(taxonomy: Taxonomy, dimension: string, value: string): void {
  const allowed = taxonomy.dimensions[dimension];
  if (!allowed) {
    throw new TaxonomyError(
      'taxonomy.unknown-dimension',
      `Unknown taxonomy dimension "${dimension}".`,
      { dimension },
    );
  }
  if (!allowed.includes(value)) {
    throw new TaxonomyError(
      'taxonomy.unknown-tag',
      `Unknown value "${value}" for taxonomy dimension "${dimension}".`,
      { dimension, value, allowed },
    );
  }
}

/** Validate a grouped error class, always logged/referenced as `group.class`. */
export function validateErrorClass(taxonomy: Taxonomy, value: string): void {
  const parts = value.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new TaxonomyError(
      'taxonomy.invalid-error-class-format',
      `Error class "${value}" must be in "group.class" form.`,
      { value },
    );
  }
  const [group, cls] = parts as [string, string];
  const classes = taxonomy.errorGroups[group];
  if (!classes) {
    throw new TaxonomyError('taxonomy.unknown-error-group', `Unknown error group "${group}".`, {
      group,
      value,
    });
  }
  if (!classes.includes(cls)) {
    throw new TaxonomyError(
      'taxonomy.unknown-error-class',
      `Unknown error class "${cls}" in group "${group}".`,
      { group, class: cls, value, allowed: classes },
    );
  }
}

/**
 * Enforce the required-dimensions-per-record-type rules (taxonomy.yml `rules:`
 * block). Checks presence of every required field, then validates each
 * field's value against its taxonomy dimension (or the group.class rule for
 * the `error` field, or mere non-empty presence for reference-only fields).
 */
export function validateRequiredDimensions(
  taxonomy: Taxonomy,
  recordType: string,
  record: Record<string, unknown>,
): void {
  const required = taxonomy.requiredDimensions[recordType];
  if (!required) {
    throw new TaxonomyError(
      'taxonomy.unknown-record-type',
      `Unknown record type "${recordType}" — no required-dimensions rule for it.`,
      { recordType },
    );
  }

  for (const field of required) {
    const value = record[field];
    const isEmpty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
    if (isEmpty) {
      throw new TaxonomyError(
        'taxonomy.missing-required-dimension',
        `Record type "${recordType}" is missing required field "${field}".`,
        { recordType, field },
      );
    }

    if (PRESENCE_ONLY_FIELDS.has(field)) continue;

    if (field === ERROR_CLASS_FIELD) {
      validateErrorClass(taxonomy, String(value));
      continue;
    }

    validateTag(taxonomy, field, String(value));
  }
}
