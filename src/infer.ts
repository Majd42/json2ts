/**
 * JSON → TypeScript type inference engine.
 *
 * Pipeline: infer a raw type tree → merge (arrays collapse their elements,
 * object shapes with differing keys unify into one interface with optional
 * properties) → register objects as named, de-duplicated interfaces → render.
 */

export interface Options {
  /** Name for the top-level type. */
  rootName: string;
  /** Emit `interface X {}` (default) or `type X = {}`. */
  declaration: "interface" | "type";
  /** Placeholder for values that can't be inferred (empty arrays). */
  unknownType: "unknown" | "any";
  /** Prefix every property with `readonly`. */
  readonly: boolean;
  /** Prefix every declaration with `export`. */
  export: boolean;
  /** Indentation string per level. */
  indent: string;
}

export const defaultOptions: Options = {
  rootName: "Root",
  declaration: "interface",
  unknownType: "unknown",
  readonly: false,
  export: false,
  indent: "  ",
};

/* ---------- raw type model (pre-registration) ---------- */

type Raw =
  | { kind: "primitive"; name: "string" | "number" | "boolean" | "null" }
  | { kind: "unknown" }
  | { kind: "array"; element: Raw }
  | { kind: "object"; fields: Map<string, Field>; hint: string }
  | { kind: "union"; members: Raw[] };

interface Field {
  type: Raw;
  optional: boolean;
}

/* ---------- public entry point ---------- */

export function jsonToTs(value: unknown, options: Partial<Options> = {}): string {
  const opts = { ...defaultOptions, ...options };
  const raw = infer(value, opts.rootName);

  const reg = new Registry(opts);

  // When the root is an object it claims `rootName` as its interface. Otherwise
  // the name belongs to a type alias, so reserve it before resolving nested
  // objects to prevent a collision (e.g. `type Users = Users[]`).
  if (raw.kind !== "object") reg.reserve(opts.rootName);

  const rootRef = resolve(raw, opts.rootName, reg);

  if (rootRef.kind === "object") {
    return reg.emit(rootRef.name) + "\n";
  }
  // Root isn't an object: emit nested interfaces (if any) then a type alias.
  const prefix = opts.export ? "export " : "";
  const nested = reg.emit(null);
  const alias = `${prefix}type ${opts.rootName} = ${render(rootRef, opts)};`;
  return (nested ? nested + "\n\n" : "") + alias + "\n";
}

/* ---------- phase 1: infer raw tree ---------- */

function infer(value: unknown, hint: string): Raw {
  if (value === null) return { kind: "primitive", name: "null" };
  const t = typeof value;
  if (t === "string") return { kind: "primitive", name: "string" };
  if (t === "number") return { kind: "primitive", name: "number" };
  if (t === "boolean") return { kind: "primitive", name: "boolean" };

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", element: { kind: "unknown" } };
    const elemHint = singularize(hint);
    const element = combine(value.map((v) => infer(v, elemHint)));
    return { kind: "array", element };
  }

  if (t === "object") {
    const fields = new Map<string, Field>();
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      fields.set(key, { type: infer(v, key), optional: false });
    }
    return { kind: "object", fields, hint };
  }

  return { kind: "unknown" };
}

/* ---------- phase 2: merge a set of branches into one type ---------- */

function combine(branches: Raw[]): Raw {
  const flat: Raw[] = [];
  for (const b of branches) {
    if (b.kind === "union") flat.push(...b.members);
    else flat.push(b);
  }

  const objects = flat.filter((b): b is Extract<Raw, { kind: "object" }> => b.kind === "object");
  const arrays = flat.filter((b): b is Extract<Raw, { kind: "array" }> => b.kind === "array");
  const rest = flat.filter((b) => b.kind !== "object" && b.kind !== "array");

  const result: Raw[] = [];
  if (objects.length) result.push(mergeObjects(objects));
  if (arrays.length) result.push({ kind: "array", element: combine(arrays.map((a) => a.element)) });

  const seen = new Set<string>();
  for (const r of rest) {
    const sig = signature(r);
    if (seen.has(sig)) continue;
    seen.add(sig);
    result.push(r);
  }

  // An explicit `unknown` is subsumed by any concrete type.
  const concrete = result.filter((r) => r.kind !== "unknown");
  const final = concrete.length ? concrete : result;

  return final.length === 1 ? final[0] : { kind: "union", members: final };
}

/** Unify object shapes: union of keys; a key absent from any becomes optional. */
function mergeObjects(objects: Extract<Raw, { kind: "object" }>[]): Raw {
  if (objects.length === 1) return objects[0];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const o of objects) {
    for (const k of o.fields.keys()) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const fields = new Map<string, Field>();
  for (const key of keys) {
    const present = objects.filter((o) => o.fields.has(key));
    const type = combine(present.map((o) => o.fields.get(key)!.type));
    const optional = present.length < objects.length || present.some((o) => o.fields.get(key)!.optional);
    fields.set(key, { type, optional });
  }
  return { kind: "object", fields, hint: objects[0].hint };
}

/* ---------- phase 3: register objects as named interfaces ---------- */

type Ref =
  | { kind: "primitive"; name: string }
  | { kind: "unknown" }
  | { kind: "array"; element: Ref }
  | { kind: "object"; name: string }
  | { kind: "union"; members: Ref[] };

interface EmittedShape {
  fields: Map<string, { type: Ref; optional: boolean }>;
}

class Registry {
  private byName = new Map<string, EmittedShape>();
  private bySignature = new Map<string, string>();
  private used = new Set<string>();
  private opts: Options;
  constructor(opts: Options) {
    this.opts = opts;
  }

  /** Mark a name as taken so no generated interface can reuse it. */
  reserve(name: string): void {
    this.used.add(name);
  }

  private uniqueName(hint: string): string {
    let base = toPascalCase(hint) || "Type";
    if (!/^[A-Za-z_]/.test(base)) base = "T" + base;
    let name = base;
    let n = 2;
    while (this.used.has(name)) name = base + n++;
    this.used.add(name);
    return name;
  }

  add(shape: EmittedShape, hint: string, sig: string): string {
    const existing = this.bySignature.get(sig);
    if (existing) return existing;
    const name = this.uniqueName(hint);
    this.bySignature.set(sig, name);
    this.byName.set(name, shape);
    return name;
  }

  emit(rootName: string | null): string {
    const names = [...this.byName.keys()];
    const ordered = rootName
      ? [rootName, ...names.filter((n) => n !== rootName)]
      : names;
    return ordered.map((n) => this.emitOne(n, this.byName.get(n)!)).join("\n\n");
  }

  private emitOne(name: string, shape: EmittedShape): string {
    const prefix = this.opts.export ? "export " : "";
    const ro = this.opts.readonly ? "readonly " : "";
    const lines: string[] = [];
    for (const [key, { type, optional }] of shape.fields) {
      const k = isValidIdentifier(key) ? key : JSON.stringify(key);
      lines.push(`${this.opts.indent}${ro}${k}${optional ? "?" : ""}: ${render(type, this.opts)};`);
    }
    const body = lines.length ? `\n${lines.join("\n")}\n` : "";
    return this.opts.declaration === "type"
      ? `${prefix}type ${name} = {${body}};`
      : `${prefix}interface ${name} {${body}}`;
  }
}

/** Walk the raw tree, registering objects and producing a render-ready Ref. */
function resolve(node: Raw, hint: string, reg: Registry): Ref {
  switch (node.kind) {
    case "primitive":
      return { kind: "primitive", name: node.name };
    case "unknown":
      return { kind: "unknown" };
    case "array":
      return { kind: "array", element: resolve(node.element, singularize(hint), reg) };
    case "union":
      return { kind: "union", members: node.members.map((m) => resolve(m, hint, reg)) };
    case "object": {
      const fields = new Map<string, { type: Ref; optional: boolean }>();
      for (const [key, f] of node.fields) {
        fields.set(key, { type: resolve(f.type, key, reg), optional: f.optional });
      }
      const shape: EmittedShape = { fields };
      const name = reg.add(shape, node.hint || hint, shapeSignature(shape));
      return { kind: "object", name };
    }
  }
}

/* ---------- rendering ---------- */

function render(ref: Ref, opts: Options): string {
  switch (ref.kind) {
    case "primitive":
      return ref.name;
    case "unknown":
      return opts.unknownType;
    case "object":
      return ref.name;
    case "array": {
      const el = render(ref.element, opts);
      return ref.element.kind === "union" ? `(${el})[]` : `${el}[]`;
    }
    case "union":
      return ref.members.map((m) => render(m, opts)).join(" | ");
  }
}

/* ---------- signatures (structural de-duplication) ---------- */

function signature(node: Raw): string {
  switch (node.kind) {
    case "primitive":
      return node.name;
    case "unknown":
      return "unknown";
    case "array":
      return "[" + signature(node.element) + "]";
    case "union":
      return "(" + node.members.map(signature).sort().join("|") + ")";
    case "object": {
      const parts: string[] = [];
      for (const [k, f] of node.fields) parts.push(`${k}${f.optional ? "?" : ""}:${signature(f.type)}`);
      return "{" + parts.sort().join(",") + "}";
    }
  }
}

function shapeSignature(shape: EmittedShape): string {
  const parts: string[] = [];
  for (const [k, f] of shape.fields) parts.push(`${k}${f.optional ? "?" : ""}:${refSignature(f.type)}`);
  return "{" + parts.sort().join(",") + "}";
}

function refSignature(ref: Ref): string {
  switch (ref.kind) {
    case "primitive":
      return ref.name;
    case "unknown":
      return "unknown";
    case "object":
      return "@" + ref.name;
    case "array":
      return "[" + refSignature(ref.element) + "]";
    case "union":
      return "(" + ref.members.map(refSignature).sort().join("|") + ")";
  }
}

/* ---------- identifier helpers ---------- */

export function toPascalCase(input: string): string {
  const words = input
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** Rough singularization for element name hints ("categories" → "Category"). */
function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, "y");
  if (/(s|sh|ch|x|z)es$/i.test(word)) return word.replace(/es$/i, "");
  if (/ss$/i.test(word)) return word;
  if (/s$/i.test(word)) return word.replace(/s$/i, "");
  return word;
}

function isValidIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}
