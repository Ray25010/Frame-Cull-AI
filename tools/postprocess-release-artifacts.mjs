import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const targets = [
  "dist/models/mediapipe/wasm/vision_wasm_internal.js",
  "dist/models/mediapipe/wasm/vision_wasm_module_internal.js",
  "dist/models/mediapipe/wasm/vision_wasm_nosimd_internal.js",
].map((path) => join(root, path));

const replacements = [
  {
    pattern: /var out = console\.log\.bind\(console\);/g,
    replacement: "var out = function(){};",
  },
  {
    pattern: /var err = console\.error\.bind\(console\);/g,
    replacement: "var err = function(){};",
  },
  {
    pattern: /console\.warn\.apply\(console, arguments\);/g,
    replacement: "void arguments;",
  },
  {
    pattern:
      /globalThis\.ModuleFactory = ModuleFactory; globalThis\.custom_dbg = console\.warn\.bind\(console\); export default ModuleFactory;/g,
    replacement:
      "globalThis.ModuleFactory = ModuleFactory; globalThis.custom_dbg = function(){}; export default ModuleFactory;",
  },
];

let touchedFiles = 0;

for (const target of targets) {
  if (!existsSync(target)) {
    continue;
  }

  let text = readFileSync(target, "utf8");
  let changed = false;

  for (const step of replacements) {
    const next = text.replace(step.pattern, step.replacement);
    if (next !== text) {
      text = next;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(target, text, "utf8");
    touchedFiles += 1;
  }
}

console.log(`Release postprocess complete. Updated ${touchedFiles} MediaPipe loader file(s).`);
