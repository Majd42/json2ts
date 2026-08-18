# JSON → TypeScript

Paste JSON, get TypeScript types. A single self-contained web page — the whole
tool is one `dist/index.html` with no external files and no network calls, so
your data never leaves the browser.

## Use it

```bash
npm install   # once, to get esbuild
npm run build # produces dist/index.html
```

Then open `dist/index.html` in any browser (double-click it, or
`start dist/index.html` on Windows). It ships with sample data pre-loaded.

## What the inference does

- Objects become named `interface`s (or `type` aliases); nested objects get
  their own declaration named after the key.
- Arrays are typed as the **union of their elements** — `[1, "x"]` → `(number | string)[]`.
- An **array of objects with differing keys** collapses into a *single*
  interface, with keys missing from some elements marked optional (`pinned?`).
- Structurally identical shapes are **de-duplicated** into one shared interface.
- Array keys are singularized for element names (`posts` → `interface Post`),
  including common irregular plurals (`people` → `Person`, `children` → `Child`).
- Non-identifier keys are quoted (`"first-name": string`).

### Options

Root type name · `interface` vs `type` · `unknown` vs `any` for empty arrays ·
`readonly` properties · `export` declarations.

## Project layout

| Path                | What it is                                              |
| ------------------- | ------------------------------------------------------- |
| `src/infer.ts`      | The inference engine — pure, typed, no DOM. The core.   |
| `src/infer.test.ts` | Unit tests (Node's built-in runner, no test framework). |
| `src/main.ts`       | DOM wiring: debounced input, options, copy button.      |
| `src/template.html` | The page shell; `/*__BUNDLE__*/` is where JS is inlined.|
| `build.mjs`         | Bundles the TS and inlines it into `dist/index.html`.   |

## Develop

```bash
npm test            # run the engine tests (Node 22+, strips types natively)
npm run build       # rebuild dist/index.html after changes
```

The engine has no dependencies; `esbuild` is only used to bundle the browser
page. To embed the generator elsewhere, import `jsonToTs` from `src/infer.ts`.
