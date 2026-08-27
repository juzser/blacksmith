/**
 * Static analysis of `.vue` single-file components, through Vue's own compiler.
 *
 * Nothing else in this repo checks an SFC's interior. `ui/tsconfig.json`
 * covers `src/**\/*.ts` only; `vue-tsc` cannot run here at all (Volar needs
 * TypeScript's classic Node compiler API and this repo is on TypeScript 7's
 * native port, which exposes none); and `biome.json` turns
 * `noUnusedImports`/`noUnusedVariables` off for `**\/*.vue` precisely because
 * a linter that cannot read the template would call every template-only
 * import dead. The repo's other SFC gates — `cssClassDrift`, `dsVariants` —
 * read templates with regexes for the same reason.
 *
 * This module hands the problem to the compiler that actually renders these
 * files. `compileScript` reports which names the script block puts in scope;
 * `compileTemplate`, given that binding metadata, emits render code in which
 * anything the template names and the script does not provide appears as
 * `_ctx.<name>` — looked up on the component instance at runtime, which is to
 * say resolved to `undefined`, silently. Unregistered components and
 * directives leave the same trace as `_resolveComponent(…)` /
 * `_resolveDirective(…)`.
 *
 * The cross-component half (`componentApi`, `callSites`) answers the question
 * one file cannot: whether the props, events and slots a call site passes are
 * ones the component it is calling actually declares. Vue forwards an
 * unrecognised attribute to the root element and drops an unrecognised
 * listener, both without a word — see D-258, where eight call sites asked
 * eight `<Card>`s to be small and got a literal `size="sm"` on a `<div>`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { type BindingMetadata, compileScript, compileTemplate, parse } from 'vue/compiler-sfc';

/** Every `.vue` file under `dir`, recursively, in stable path order. */
export function sfcFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sfcFiles(full));
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

export interface SfcReport {
  /** Path relative to the root the scan started from. */
  file: string;
  /** Names the template reads off the instance because nothing declares them. */
  identifiers: string[];
  /** Components the template leaves for runtime resolution. */
  components: string[];
  /** Directives the template leaves for runtime resolution. */
  directives: string[];
  /** Imported local names neither the script body nor the template uses. */
  unusedImports: string[];
  /** A compiler diagnostic, or null. One is enough to make the rest moot. */
  error: string | null;
}

export interface ComponentApi {
  /** Prop names, as declared — camelCase. */
  props: string[];
  /** The subset of `props` with no `?`, so a call site must pass them. */
  requiredProps: string[];
  /** Event names from `defineEmits<{ … }>()`. */
  emits: string[];
  /** Slot names the template renders, `'default'` included. */
  slots: string[];
  /** True when a `<slot :name="…">` makes the slot set unknowable here. */
  dynamicSlots: boolean;
}

export interface CallSiteReport {
  /** Path of the calling SFC, relative to the scan root. */
  file: string;
  /** Line of the opening tag, within the calling SFC. */
  line: number;
  /** Tag as written. */
  tag: string;
  /** Attributes the called component declares no prop for. */
  unknownAttrs: string[];
  /** Required props the call site omits. */
  missingRequired: string[];
  /** Listeners the called component never emits. */
  unknownEvents: string[];
  /** Slots the called component never renders. */
  unknownSlots: string[];
}

/**
 * Names every template can read off the component instance without declaring
 * anything: Vue's public instance properties, plus the two vue-router adds to
 * every instance when `src/main.ts` calls `app.use(router)`. The compiler's
 * `_ctx.` marker on these is a fact about Vue, not about this repo.
 */
const INSTANCE_GLOBALS: ReadonlySet<string> = new Set([
  '$attrs',
  '$data',
  '$el',
  '$emit',
  '$forceUpdate',
  '$nextTick',
  '$options',
  '$parent',
  '$props',
  '$refs',
  '$root',
  '$route',
  '$router',
  '$slots',
  '$watch',
]);

/** Components registered once for the whole app rather than per-SFC. */
const GLOBAL_COMPONENTS: ReadonlySet<string> = new Set([
  'RouterLink',
  'RouterView',
  'router-link',
  'router-view',
]);

/**
 * Attributes that legitimately reach a component without being one of its
 * props, because Vue's fallthrough puts them on the root element and the
 * element is what they are for. `aria-*` and `data-*` are handled by prefix.
 */
const FALLTHROUGH_ATTRS: ReadonlySet<string> = new Set([
  'class',
  'contenteditable',
  'dir',
  'draggable',
  'hidden',
  'id',
  'is',
  'key',
  'lang',
  'ref',
  'role',
  'slot',
  'style',
  'tabindex',
  'title',
]);

/**
 * DOM events a component forwards to its root element without declaring them.
 * A listener for one of these is ordinary; a listener for anything else that
 * the component does not emit is a handler that will never run.
 */
const NATIVE_EVENTS: ReadonlySet<string> = new Set([
  'blur',
  'change',
  'click',
  'contextmenu',
  'copy',
  'cut',
  'dblclick',
  'drag',
  'dragover',
  'dragstart',
  'drop',
  'focus',
  'focusin',
  'focusout',
  'input',
  'keydown',
  'keypress',
  'keyup',
  'mousedown',
  'mouseenter',
  'mouseleave',
  'mousemove',
  'mouseup',
  'paste',
  'pointerdown',
  'pointerup',
  'scroll',
  'submit',
  'toggle',
  'wheel',
]);

/** Vue's own AST tags, named rather than left as the integers they are. */
const ELEMENT_NODE = 1;
const ATTRIBUTE_PROP = 6;
const DIRECTIVE_PROP = 7;
const TEMPLATE_ELEMENT = 3;

interface AstProp {
  type: number;
  name: string;
  arg?: { content?: string };
}
interface AstNode {
  type: number;
  tag?: string;
  tagType?: number;
  props?: AstProp[];
  children?: AstNode[];
  branches?: AstNode[];
  loc?: { start: { line: number } };
}

const kebab = (name: string): string => name.replace(/(?<!^)([A-Z])/g, '-$1').toLowerCase();
const camel = (name: string): string =>
  name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** `MyThing` and `my-thing` both name the file `MyThing.vue`. */
function namesSelf(component: string, file: string): boolean {
  const self = basename(file, '.vue');
  return component === self || component === kebab(self);
}

/**
 * The local names an import statement binds, ignoring the module specifier.
 * Deliberately textual: the script block is TypeScript, and parsing it
 * properly would mean a second compiler this repo has no way to run.
 */
function importedNames(script: string): Array<{ name: string; statement: string }> {
  const found: Array<{ name: string; statement: string }> = [];
  for (const match of script.matchAll(/import\s+([^;'"]*?)\s*from\s*['"][^'"]+['"]/g)) {
    const clause = match[1] as string;
    if (clause.trim().startsWith('type ')) continue;
    const braced = clause.match(/\{([^}]*)\}/);
    const bare = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, ' ')
      .trim();
    if (bare && !bare.startsWith('*')) found.push({ name: bare, statement: match[0] as string });
    for (const specifier of braced ? (braced[1] as string).split(',') : []) {
      const trimmed = specifier.trim();
      if (!trimmed || trimmed.startsWith('type ')) continue;
      const local = trimmed.split(/\s+as\s+/).pop();
      if (local) found.push({ name: local.trim(), statement: match[0] as string });
    }
  }
  return found;
}

/** Source with comments and string bodies blanked, so a mention is a use. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

function mentions(haystack: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(haystack);
}

/** Compile one SFC's source and report what it leaves to runtime. */
export function analyzeSource(source: string, filename: string, root = ''): SfcReport {
  const rel = root ? relative(root, filename) : filename;
  const empty: SfcReport = {
    file: rel,
    identifiers: [],
    components: [],
    directives: [],
    unusedImports: [],
    error: null,
  };
  const { descriptor, errors } = parse(source, { filename });
  if (errors.length > 0) return { ...empty, error: `parse: ${String(errors[0])}` };

  let bindings: BindingMetadata | undefined;
  const script = descriptor.scriptSetup ?? descriptor.script;
  if (script) {
    try {
      bindings = compileScript(descriptor, { id: rel }).bindings;
    } catch (cause) {
      return { ...empty, error: `compileScript: ${(cause as Error).message}` };
    }
  }

  let code = '';
  if (descriptor.template) {
    const rendered = compileTemplate({
      source: descriptor.template.content,
      filename,
      id: rel,
      compilerOptions: { bindingMetadata: bindings, prefixIdentifiers: true },
    });
    if (rendered.errors.length > 0) {
      return { ...empty, error: `compileTemplate: ${String(rendered.errors[0])}` };
    }
    code = rendered.code;
  }

  const unique = (matches: Iterable<RegExpMatchArray>): string[] => [
    ...new Set(Array.from(matches, (m) => m[1] as string)),
  ];
  const identifiers = unique(code.matchAll(/_ctx\.([A-Za-z_$][\w$]*)/g))
    .filter((name) => !INSTANCE_GLOBALS.has(name))
    .sort();
  const components = unique(code.matchAll(/_resolveComponent\("([^"]+)"/g))
    .filter((name) => !GLOBAL_COMPONENTS.has(name) && !namesSelf(name, filename))
    .sort();
  const directives = unique(code.matchAll(/_resolveDirective\("([^"]+)"/g)).sort();

  const body = script ? codeOnly(script.content) : '';
  const unusedImports = script
    ? [
        ...new Set(
          importedNames(script.content)
            .filter(({ name, statement }) => {
              const withoutImport = body.replace(codeOnly(statement), ' ');
              return !mentions(withoutImport, name) && !mentions(code, name);
            })
            .map(({ name }) => name),
        ),
      ].sort()
    : [];

  return { file: rel, identifiers, components, directives, unusedImports, error: null };
}

/** {@link analyzeSource} for a file on disk. */
export function analyzeSfc(file: string, root: string): SfcReport {
  return analyzeSource(readFileSync(file, 'utf8'), file, root);
}

/**
 * What one component declares it accepts.
 *
 * Props come from the compiler's own binding metadata; required-ness, emits
 * and slot names are read textually, because they live in type positions the
 * bindings do not carry. Every SFC in `ui/src` writes them the one way this
 * reads — `defineProps<{ … }>()`, `defineEmits<{ name: [args] }>()` — and a
 * declaration written some other way degrades to "declares nothing", which
 * reports call sites rather than hiding them.
 */
export function componentApi(source: string, filename: string): ComponentApi {
  const { descriptor } = parse(source, { filename });
  const body = (descriptor.scriptSetup?.content ?? '') + (descriptor.script?.content ?? '');

  let props: string[] = [];
  if (descriptor.scriptSetup ?? descriptor.script) {
    try {
      const bindings = compileScript(descriptor, { id: filename }).bindings ?? {};
      props = Object.keys(bindings).filter((name) => bindings[name] === 'props');
    } catch {
      /* analyzeSource reports the compiler failure; here it just means no props. */
    }
  }

  const requiredProps: string[] = [];
  const propBlock = body.match(/defineProps<\{([\s\S]*?)\}>\(\)/);
  if (propBlock) {
    for (const line of (propBlock[1] as string).split('\n')) {
      const declared = line.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\??):/);
      if (declared && declared[2] === '') requiredProps.push(declared[1] as string);
    }
  }

  const emits: string[] = [];
  const emitBlock = body.match(/defineEmits<\{([\s\S]*?)\}>\(\)/);
  if (emitBlock) {
    for (const entry of (emitBlock[1] as string).matchAll(
      /(?:^|[;,{])\s*'?([A-Za-z_$][\w$:]*)'?\s*:/g,
    )) {
      emits.push(entry[1] as string);
    }
  }

  const slots: string[] = [];
  let dynamicSlots = false;
  const template = descriptor.template?.content ?? '';
  for (const tag of template.matchAll(/<slot\b([^>]*)>/g)) {
    const attrs = tag[1] as string;
    if (/(?::|v-bind:)name=/.test(attrs)) {
      dynamicSlots = true;
      continue;
    }
    const named = attrs.match(/\bname="([^"]+)"/);
    slots.push(named ? (named[1] as string) : 'default');
  }
  for (const use of `${template}${body}`.matchAll(/\$slots\.([A-Za-z_$][\w$]*)/g)) {
    slots.push(use[1] as string);
  }

  return {
    props: [...new Set(props)].sort(),
    requiredProps: [...new Set(requiredProps)].sort(),
    emits: [...new Set(emits)].sort(),
    slots: [...new Set(slots)].sort(),
    dynamicSlots,
  };
}

function declares(api: ComponentApi, kind: 'props' | 'emits' | 'slots', name: string): boolean {
  const declared = api[kind];
  return (
    declared.includes(name) || declared.includes(camel(name)) || declared.includes(kebab(name))
  );
}

/**
 * Every place `source` renders a component it imported from another SFC, and
 * what that call site got wrong.
 *
 * `resolveApi` maps an imported `.vue` path to its {@link ComponentApi};
 * returning null skips the call site, which is what a component from outside
 * the scanned tree deserves. An element carrying `v-bind="obj"` is skipped
 * whole: the spread could supply anything, so no claim about it is safe.
 */
export function callSites(
  source: string,
  filename: string,
  root: string,
  resolveApi: (path: string) => ComponentApi | null,
): CallSiteReport[] {
  const { descriptor } = parse(source, { filename });
  const ast = descriptor.template?.ast as AstNode | undefined;
  if (!ast) return [];

  const script = (descriptor.scriptSetup?.content ?? '') + (descriptor.script?.content ?? '');
  const imports = new Map<string, string>();
  for (const match of script.matchAll(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+\.vue)['"]/g,
  )) {
    imports.set(match[1] as string, resolve(dirname(filename), match[2] as string));
  }
  if (imports.size === 0) return [];

  const found: CallSiteReport[] = [];
  const visit = (node: AstNode): void => {
    const target = node.type === ELEMENT_NODE && node.tag ? imports.get(node.tag) : undefined;
    const api = target ? resolveApi(target) : null;
    if (api) {
      const passed = new Set<string>();
      const events: string[] = [];
      let spread = false;
      for (const prop of node.props ?? []) {
        if (prop.type === ATTRIBUTE_PROP) passed.add(prop.name);
        else if (prop.type === DIRECTIVE_PROP && prop.name === 'bind') {
          if (prop.arg?.content) passed.add(prop.arg.content);
          else spread = true;
        } else if (prop.type === DIRECTIVE_PROP && prop.name === 'model') {
          passed.add(prop.arg?.content ?? 'modelValue');
        } else if (prop.type === DIRECTIVE_PROP && prop.name === 'on' && prop.arg?.content) {
          events.push(prop.arg.content);
        }
      }
      const slotsUsed: string[] = [];
      for (const child of node.children ?? []) {
        if (child.type !== ELEMENT_NODE || child.tagType !== TEMPLATE_ELEMENT) continue;
        for (const prop of child.props ?? []) {
          if (prop.type === DIRECTIVE_PROP && prop.name === 'slot' && prop.arg?.content) {
            slotsUsed.push(prop.arg.content);
          }
        }
      }

      const report: CallSiteReport = {
        file: root ? relative(root, filename) : filename,
        line: node.loc?.start.line ?? 0,
        tag: node.tag as string,
        unknownAttrs: spread
          ? []
          : [...passed].filter(
              (attr) =>
                !declares(api, 'props', attr) &&
                !FALLTHROUGH_ATTRS.has(attr) &&
                !attr.startsWith('aria-') &&
                !attr.startsWith('data-'),
            ),
        missingRequired: spread
          ? []
          : api.requiredProps.filter((prop) => !passed.has(prop) && !passed.has(kebab(prop))),
        unknownEvents: events.filter(
          (event) =>
            !declares(api, 'emits', event) &&
            !NATIVE_EVENTS.has(event) &&
            !NATIVE_EVENTS.has(kebab(event)),
        ),
        unknownSlots: api.dynamicSlots
          ? []
          : slotsUsed.filter((slot) => !declares(api, 'slots', slot)),
      };
      if (
        report.unknownAttrs.length > 0 ||
        report.missingRequired.length > 0 ||
        report.unknownEvents.length > 0 ||
        report.unknownSlots.length > 0
      ) {
        found.push(report);
      }
    }
    for (const child of node.children ?? []) visit(child);
    for (const branch of node.branches ?? []) visit(branch);
  };
  visit(ast);
  return found;
}

/** {@link callSites} across every SFC under `root`, resolving APIs from disk. */
export function scanCallSites(root: string): CallSiteReport[] {
  const apis = new Map<string, ComponentApi | null>();
  const resolveApi = (path: string): ComponentApi | null => {
    if (!apis.has(path)) {
      try {
        apis.set(path, componentApi(readFileSync(path, 'utf8'), path));
      } catch {
        apis.set(path, null);
      }
    }
    return apis.get(path) ?? null;
  };
  return sfcFiles(root).flatMap((file) =>
    callSites(readFileSync(file, 'utf8'), file, root, resolveApi),
  );
}
