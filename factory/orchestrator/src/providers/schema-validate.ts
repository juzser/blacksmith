// Shared by cli-transport.ts and api-transport.ts: pull the first balanced
// JSON value out of a judge's raw text response (tolerating surrounding
// prose — LLMs routinely wrap JSON in a sentence or a markdown fence) and
// schema-validate it via the same schemas.ts/taxonomy.ts pipeline the rest
// of the orchestrator uses (gate.ts, findings.ts) — no bespoke validation
// path for provider output.
import {
  type CompiledSchemaSet,
  compileSchemas,
  type ValidationIssue,
  validateRecord,
} from '../schemas.js';
import { loadTaxonomy, type Taxonomy } from '../taxonomy.js';

export interface SchemaResolveOpts {
  taxonomy?: Taxonomy;
  schemas?: CompiledSchemaSet;
}

let cachedTaxonomy: Taxonomy | undefined;
let cachedSchemas: CompiledSchemaSet | undefined;

function resolve(opts: SchemaResolveOpts): { taxonomy: Taxonomy; schemas: CompiledSchemaSet } {
  if (cachedTaxonomy === undefined) cachedTaxonomy = loadTaxonomy();
  if (cachedSchemas === undefined) cachedSchemas = compileSchemas(cachedTaxonomy);
  return { taxonomy: opts.taxonomy ?? cachedTaxonomy, schemas: opts.schemas ?? cachedSchemas };
}

/**
 * Every substring of `text` that starts at a `{`/`[`, balances to its matching
 * `}`/`]` (respecting quoted strings/escapes), and parses as JSON — yielded in
 * the order they appear. Candidate starts that balance but fail to parse are
 * skipped rather than ending the scan.
 *
 * D-118: there is deliberately no "the first one is the answer" rule here.
 * Real `codex exec` echoes the prompt back on stderr, the transport merges
 * stderr into this buffer for extraction, and a prompt that mentions `[]` or
 * shows a schema template therefore plants parseable JSON *ahead* of the
 * verdict. Only the caller's schema can say which candidate is the answer.
 */
function* balancedJsonCandidates(text: string): Generator<unknown> {
  for (let i = 0; i < text.length; i++) {
    const startChar = text[i];
    if (startChar !== '{' && startChar !== '[') continue;
    const closeChar = startChar === '{' ? '}' : ']';

    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (isEscaped) isEscaped = false;
        else if (c === '\\') isEscaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      // Only the START bracket's own family is depth-counted. Valid JSON
      // never lets `{`/`[` cross-nest without also closing in order (e.g.
      // "{[}]" is not legal JSON), so tracking one family is sufficient to
      // find where the top-level value actually ends; JSON.parse below is
      // the real correctness check regardless.
      if (c === startChar) depth++;
      else if (c === closeChar) {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          let parsed: unknown;
          try {
            parsed = JSON.parse(candidate);
          } catch {
            break; // not valid JSON after all — resume scanning from i + 1
          }
          yield parsed;
          // Resume *after* this value rather than inside it: a nested object
          // is part of the value already yielded, never a sibling answer.
          i = j;
          break;
        }
      }
    }
  }
}

/**
 * The first balanced, parseable JSON value in `text`, or null if there is none.
 * Unaware of any schema — kept for callers that genuinely want "whatever JSON
 * this text contains". Judge output goes through `extractAndValidate`, which
 * picks by schema; see D-118 on why the difference matters.
 */
export function extractBalancedJson(text: string): unknown | null {
  for (const candidate of balancedJsonCandidates(text)) return candidate;
  return null;
}

export type JudgeOutputResult =
  | { valid: true; value: unknown }
  | { valid: false; reason: 'no-json-found' }
  | { valid: false; reason: 'schema-invalid'; errors: ValidationIssue[] };

/**
 * Schemas that describe ONE item a `kind: review` judge returns MANY of. Both
 * of them: `finding` is the stored record (the native reviewer's contract,
 * .claude/agents/reviewer.md), `finding-evidence` is the judge's half of it —
 * the same evidence without the six identity fields the orchestrator owns.
 * A set, not a comparison, because the second entry was added a year after the
 * first and the `=== 'finding'` it replaced would have silently validated an
 * array of evidence as a single malformed object.
 */
const ARRAY_VALUED_SCHEMAS: ReadonlySet<string> = new Set(['finding', 'finding-evidence']);

/**
 * The list a judge answered with for an array-valued schema, or undefined when
 * it answered with some other shape. A bare array is the list. An object with
 * exactly one key whose value is an array is the list wrapped — the shape an
 * API judge under `response_format: json_object` has to produce, because that
 * mode refuses a top-level array (FD-41; deepseek-chat answered
 * `{"findings":[...]}` and lost the whole review to `schema-invalid`).
 * Anything else — a bare record, a wrapper with a second key, a scalar — is
 * refused: `balancedJsonCandidates` never descends into a value it has
 * yielded, so this is the only place a wrapped list can be recognised, and it
 * recognises exactly that one shape rather than searching for an array
 * somewhere inside the answer.
 */
function unwrapArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length !== 1) return undefined;
  const inner = (parsed as Record<string, unknown>)[keys[0] as string];
  return Array.isArray(inner) ? inner : undefined;
}

function describeShape(parsed: unknown): string {
  if (Array.isArray(parsed)) return 'an array';
  if (parsed === null) return 'null';
  if (typeof parsed === 'object') return `an object with ${Object.keys(parsed).length} key(s)`;
  return `a ${typeof parsed}`;
}

/**
 * Extract + schema-validate a judge's raw text response. `finding.schema.json`
 * describes ONE finding, but a `kind: review` judge's contract
 * (.claude/agents/reviewer.md) returns an ARRAY of findings — so against an
 * ARRAY_VALUED_SCHEMAS name the top-level value must be that array, bare or
 * wrapped in one single-key object (see `unwrapArray`), and validates
 * element-wise; the value returned is the array itself, unwrapped. A bare
 * record is refused there even when it would validate on its own: one finding
 * where a list was asked for is a judge that misread its contract, and
 * accepting it would file the answer as a review of exactly one issue. Every
 * other schema (e.g. "judge-verdict") validates the parsed value directly
 * against its own object shape.
 */
export function extractAndValidate(
  rawText: string,
  schemaName: string,
  opts: SchemaResolveOpts = {},
): JudgeOutputResult {
  const { taxonomy, schemas } = resolve(opts);

  const validateOne = (parsed: unknown): JudgeOutputResult => {
    if (ARRAY_VALUED_SCHEMAS.has(schemaName)) {
      const items = unwrapArray(parsed);
      if (items === undefined) {
        return {
          valid: false,
          reason: 'schema-invalid',
          errors: [
            {
              path: '',
              message: `expected an array of ${schemaName} records (or one object whose single key holds that array); got ${describeShape(parsed)}`,
            },
          ],
        };
      }
      const errors: ValidationIssue[] = [];
      items.forEach((item, index) => {
        const result = validateRecord(schemas, taxonomy, schemaName, item);
        if (!result.valid) {
          errors.push(
            ...result.errors.map((e) => ({ path: `/${index}${e.path}`, message: e.message })),
          );
        }
      });
      if (errors.length > 0) return { valid: false, reason: 'schema-invalid', errors };
      return { valid: true, value: items };
    }

    const result = validateRecord(schemas, taxonomy, schemaName, parsed);
    if (!result.valid) return { valid: false, reason: 'schema-invalid', errors: result.errors };
    return { valid: true, value: parsed };
  };

  // D-118: take the first candidate that VALIDATES, not the first that parses.
  // The judge's answer is the thing shaped like an answer; a decoy that merely
  // parses — a schema template, a protocol banner — is not made into one by
  // arriving first.
  //
  // D-195: that bar does not stop a decoy that is itself a VALID answer. An
  // echoed `[]` validates vacuously as an empty finding array, and a verdict
  // planted in a finding's summary validates as a verdict. This function
  // cannot tell those from the real thing — by the time text arrives here,
  // who said it is gone. Keeping our own prompt out of `rawText` is the
  // caller's job; cli-transport.ts's withoutEcho() does it.
  let firstFailure: JudgeOutputResult | undefined;
  for (const parsed of balancedJsonCandidates(rawText)) {
    const result = validateOne(parsed);
    if (result.valid) return result;
    // Keep the earliest failure so a judge that answered *badly* still gets a
    // schema critique rather than a bare "no JSON found".
    firstFailure ??= result;
  }

  return firstFailure ?? { valid: false, reason: 'no-json-found' };
}
