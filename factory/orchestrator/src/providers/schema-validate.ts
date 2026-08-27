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
 * Extract + schema-validate a judge's raw text response. `finding.schema.json`
 * describes ONE finding, but a `kind: review` judge's contract
 * (.claude/agents/reviewer.md) returns an ARRAY of findings — so an array
 * top-level value against an ARRAY_VALUED_SCHEMAS name validates element-wise;
 * every other schema (e.g. "judge-verdict") validates the parsed value
 * directly against its own object shape.
 */
export function extractAndValidate(
  rawText: string,
  schemaName: string,
  opts: SchemaResolveOpts = {},
): JudgeOutputResult {
  const { taxonomy, schemas } = resolve(opts);

  const validateOne = (parsed: unknown): JudgeOutputResult => {
    if (ARRAY_VALUED_SCHEMAS.has(schemaName) && Array.isArray(parsed)) {
      const errors: ValidationIssue[] = [];
      parsed.forEach((item, index) => {
        const result = validateRecord(schemas, taxonomy, schemaName, item);
        if (!result.valid) {
          errors.push(
            ...result.errors.map((e) => ({ path: `/${index}${e.path}`, message: e.message })),
          );
        }
      });
      if (errors.length > 0) return { valid: false, reason: 'schema-invalid', errors };
      return { valid: true, value: parsed };
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
