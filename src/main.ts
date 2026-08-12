import { jsonToTs, type Options } from "./infer.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const input = $<HTMLTextAreaElement>("input");
const output = $<HTMLElement>("output");
const status = $<HTMLElement>("status");
const copyBtn = $<HTMLButtonElement>("copy");

const controls = {
  rootName: $<HTMLInputElement>("rootName"),
  declaration: $<HTMLSelectElement>("declaration"),
  unknownType: $<HTMLSelectElement>("unknownType"),
  readonly: $<HTMLInputElement>("readonly"),
  export: $<HTMLInputElement>("export"),
};

const SAMPLE = {
  id: 42,
  name: "Ada Lovelace",
  active: true,
  roles: ["admin", "author"],
  profile: { avatar: null, joined: "1843-01-01" },
  posts: [
    { slug: "notes", views: 10 },
    { slug: "engine", views: 99, pinned: true },
  ],
};

function currentOptions(): Partial<Options> {
  return {
    rootName: controls.rootName.value.trim() || "Root",
    declaration: controls.declaration.value as Options["declaration"],
    unknownType: controls.unknownType.value as Options["unknownType"],
    readonly: controls.readonly.checked,
    export: controls.export.checked,
  };
}

function setStatus(text: string, kind: "ok" | "error" | "muted") {
  status.textContent = text;
  status.dataset.kind = kind;
}

function generate() {
  const raw = input.value.trim();
  if (!raw) {
    output.textContent = "";
    setStatus("Paste some JSON to get started.", "muted");
    copyBtn.disabled = true;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    setStatus(`Invalid JSON: ${(err as Error).message}`, "error");
    copyBtn.disabled = true;
    return;
  }
  try {
    output.textContent = jsonToTs(parsed, currentOptions());
    const lines = output.textContent.split("\n").length;
    setStatus(`Generated · ${lines} lines`, "ok");
    copyBtn.disabled = false;
  } catch (err) {
    setStatus(`Could not generate types: ${(err as Error).message}`, "error");
    copyBtn.disabled = true;
  }
}

let timer: number | undefined;
function scheduleGenerate() {
  window.clearTimeout(timer);
  timer = window.setTimeout(generate, 150);
}

input.addEventListener("input", scheduleGenerate);
for (const el of Object.values(controls)) el.addEventListener("input", generate);

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(output.textContent ?? "");
    const prev = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    window.setTimeout(() => (copyBtn.textContent = prev), 1200);
  } catch {
    setStatus("Clipboard blocked — select and copy manually.", "error");
  }
});

$<HTMLButtonElement>("sample").addEventListener("click", () => {
  input.value = JSON.stringify(SAMPLE, null, 2);
  generate();
});

$<HTMLButtonElement>("clear").addEventListener("click", () => {
  input.value = "";
  generate();
  input.focus();
});

// Seed with the sample so the tool is self-explanatory on first load.
input.value = JSON.stringify(SAMPLE, null, 2);
generate();
