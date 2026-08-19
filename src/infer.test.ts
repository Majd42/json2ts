import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonToTs, toPascalCase } from "./infer.ts";

test("primitives on a flat object", () => {
  const out = jsonToTs({ id: 1, name: "Ada", active: true, tags: null });
  assert.equal(
    out.trim(),
    [
      "interface Root {",
      "  id: number;",
      "  name: string;",
      "  active: boolean;",
      "  tags: null;",
      "}",
    ].join("\n"),
  );
});

test("nested object becomes its own interface", () => {
  const out = jsonToTs({ user: { name: "Ada" } }, { rootName: "Payload" });
  assert.match(out, /interface Payload \{[\s\S]*user: User;[\s\S]*\}/);
  assert.match(out, /interface User \{\s*name: string;\s*\}/);
});

test("array of primitives → element[]", () => {
  const out = jsonToTs({ nums: [1, 2, 3] });
  assert.match(out, /nums: number\[\];/);
});

test("array of mixed primitives → union element", () => {
  const out = jsonToTs({ vals: [1, "x", true] });
  assert.match(out, /vals: \(number \| string \| boolean\)\[\];/);
});

test("array of objects with differing keys → one interface, optional props", () => {
  const out = jsonToTs({ items: [{ a: 1 }, { a: 2, b: "x" }] });
  assert.match(out, /items: Item\[\];/);
  assert.match(out, /interface Item \{\s*a: number;\s*b\?: string;\s*\}/);
});

test("identical nested shapes are de-duplicated", () => {
  const out = jsonToTs({ from: { lat: 1, lng: 2 }, to: { lat: 3, lng: 4 } });
  // Only one interface should be generated for the two identical points.
  const interfaces = out.match(/interface \w+ \{/g) ?? [];
  assert.equal(interfaces.length, 2); // Root + one shared point interface
});

test("empty array → unknown[] (respects unknownType)", () => {
  assert.match(jsonToTs({ x: [] }), /x: unknown\[\];/);
  assert.match(jsonToTs({ x: [] }, { unknownType: "any" }), /x: any\[\];/);
});

test("invalid identifier keys are quoted", () => {
  const out = jsonToTs({ "first-name": "Ada", "123": 1 });
  assert.match(out, /"first-name": string;/);
  assert.match(out, /"123": number;/);
});

test("root array of objects → alias over element interface", () => {
  const out = jsonToTs([{ id: 1 }, { id: 2 }], { rootName: "Rows" });
  assert.match(out, /interface Row \{\s*id: number;\s*\}/);
  assert.match(out, /type Rows = Row\[\];/);
});

test("root keeps rootName when a nested key collides with it", () => {
  const out = jsonToTs({ user: { name: "Ada" } }, { rootName: "User" });
  // The root interface must own `User`; the nested object is bumped instead.
  assert.match(out, /interface User \{\s*user: User2;\s*\}/);
  assert.match(out, /interface User2 \{\s*name: string;\s*\}/);
});

test("irregular plurals singularize for element names", () => {
  const people = jsonToTs({ people: [{ name: "Ada" }] });
  assert.match(people, /people: Person\[\];/);
  assert.match(people, /interface Person \{\s*name: string;\s*\}/);

  const children = jsonToTs({ children: [{ age: 3 }] });
  assert.match(children, /children: Child\[\];/);

  // -ves plurals whose singular ending isn't rule-derivable.
  const leaves = jsonToTs({ leaves: [{ vein: 1 }] });
  assert.match(leaves, /leaves: Leaf\[\];/);

  const knives = jsonToTs({ knives: [{ blade: "steel" }] });
  assert.match(knives, /knives: Knife\[\];/);
});

test("root primitive → type alias", () => {
  assert.equal(jsonToTs(42, { rootName: "N" }).trim(), "type N = number;");
});

test("options: export + readonly + type declaration", () => {
  const out = jsonToTs({ id: 1 }, { export: true, readonly: true, declaration: "type" });
  assert.match(out, /export type Root = \{\s*readonly id: number;\s*\};/);
});

test("toPascalCase handles separators and camelCase", () => {
  assert.equal(toPascalCase("first_name"), "FirstName");
  assert.equal(toPascalCase("user-profile"), "UserProfile");
  assert.equal(toPascalCase("alreadyPascal"), "AlreadyPascal");
});
