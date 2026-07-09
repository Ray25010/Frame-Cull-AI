import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");
const tauriFlashConfig = join(root, "src-tauri", "tauri.flash.conf.json");
const tauriProConfig = join(root, "src-tauri", "tauri.pro.conf.json");
const rawTherapeeVendorDir = join(root, "src-tauri", "vendor", "rawtherapee", "windows-x64", "RawTherapee_5.12_win64_release");
const rawTherapeeCli = join(rawTherapeeVendorDir, "rawtherapee-cli.exe");
const rawTherapeeNotice = join(root, "src-tauri", "vendor", "rawtherapee", "THIRD_PARTY_NOTICES.txt");
const rawTherapeeManifest = join(root, "src-tauri", "vendor", "rawtherapee", "rawtherapee-5.12-win64.json");
const cudaRuntimeVendorDir = join(root, "src-tauri", "vendor", "nvidia-cuda", "windows-x64", "runtime");
const cudaRuntimeLock = join(root, "src-tauri", "vendor", "nvidia-cuda", "windows-x64", "runtime-lock.json");
const cudaRuntimeLicenses = join(root, "src-tauri", "vendor", "nvidia-cuda", "windows-x64", "licenses");
const cudaRuntimeNotice = join(root, "src-tauri", "vendor", "nvidia-cuda", "windows-x64", "THIRD_PARTY_NOTICES.txt");

function readEditionArg(argv) {
  const equalsArg = argv.find((arg) => arg.startsWith("--edition="));
  if (equalsArg) return equalsArg.split("=")[1];
  const flagIndex = argv.indexOf("--edition");
  if (flagIndex >= 0) return argv[flagIndex + 1];
  return undefined;
}

const edition = (readEditionArg(process.argv) || "flash").toLowerCase();
const textExtensions = new Set([".html", ".js", ".css", ".json", ".svg", ".txt"]);
const forbiddenFiles = new Set([".map", ".ts", ".tsx", ".rs"]);
const forbiddenText = [
  { pattern: /sourceMappingURL/i, label: "source map reference" },
  { pattern: /\bdebugger\b/, label: "debugger statement" },
  { pattern: /\bconsole\.(log|debug|info|warn|error)\b/, label: "console call" },
  { pattern: /tools\/ai-lab/i, label: "internal ai-lab path" },
  { pattern: /BetaActivation|FRAMECULL_LICENSE/i, label: "removed license gate residue" },
];

const editionChecks = {
  flash: {
    forbidden: [
      { pattern: /RawTherapee/i, label: "Pro RAW engine name" },
      { pattern: /rawtherapee/i, label: "Pro RAW engine executable text" },
      { pattern: /rawMonitorEngine/i, label: "Pro RAW monitor module" },
      { pattern: /RAW monitor/i, label: "Pro RAW monitor copy" },
      { pattern: /RAW monitoring/i, label: "Pro RAW monitoring copy" },
      { pattern: /RAW 监看/i, label: "Pro RAW monitor Chinese copy" },
      { pattern: /FrameCull AI Pro/i, label: "Pro product name" },
      { pattern: /cuda-runtime/i, label: "Pro CUDA runtime resource" },
      { pattern: /nvidia-cuda/i, label: "Pro NVIDIA CUDA vendor resource" },
      { pattern: /onnxruntime_providers_cuda/i, label: "Pro CUDA provider resource" },
    ],
    required: [
      { pattern: /FrameCull AI Flash/i, label: "Flash product name" },
    ],
  },
  pro: {
    forbidden: [],
    required: [
      { pattern: /FrameCull AI Pro/i, label: "Pro product name" },
      { pattern: /RawTherapee/i, label: "RawTherapee integration" },
      { pattern: /RAW monitor|RAW 监看/i, label: "RAW monitor feature copy" },
    ],
  },
};

const activeEditionChecks = editionChecks[edition] || editionChecks.flash;
const failures = [];
const seenText = [];

function rel(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }

    const ext = extname(path);
    if (forbiddenFiles.has(ext)) {
      failures.push(`${rel(path)}: forbidden release artifact extension "${ext}"`);
      continue;
    }

    if (!textExtensions.has(ext)) continue;

    const text = readFileSync(path, "utf8");
    seenText.push(text);
    for (const check of [...forbiddenText, ...activeEditionChecks.forbidden]) {
      if (check.pattern.test(text)) {
        failures.push(`${rel(path)}: contains ${check.label}`);
      }
    }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${rel(path)}: cannot parse JSON (${error.message})`);
    return null;
  }
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function checkCudaRuntimeLock() {
  if (!existsSync(cudaRuntimeLock)) {
    failures.push(`${rel(cudaRuntimeLock)}: missing CUDA runtime lock`);
    return;
  }
  if (!existsSync(cudaRuntimeVendorDir)) {
    failures.push(`${rel(cudaRuntimeVendorDir)}: missing CUDA runtime directory`);
    return;
  }
  if (!existsSync(cudaRuntimeLicenses)) {
    failures.push(`${rel(cudaRuntimeLicenses)}: missing CUDA runtime license metadata`);
  }
  if (!existsSync(cudaRuntimeNotice)) {
    failures.push(`${rel(cudaRuntimeNotice)}: missing CUDA runtime third-party notice`);
  }

  const lock = readJson(cudaRuntimeLock);
  const files = Array.isArray(lock?.files) ? lock.files : [];
  const required = Array.isArray(lock?.validation?.requiredDlls) ? lock.validation.requiredDlls : [];
  if (files.length === 0) {
    failures.push(`${rel(cudaRuntimeLock)}: lock must list bundled runtime files`);
  }
  if (required.length === 0) {
    failures.push(`${rel(cudaRuntimeLock)}: lock must list required DLLs`);
  }

  const lockedNames = new Set();
  for (const entry of files) {
    const entryPath = typeof entry.path === "string" ? entry.path : "";
    const name = entryPath.split("/").pop();
    if (!name) {
      failures.push(`${rel(cudaRuntimeLock)}: runtime entry has no file name`);
      continue;
    }
    lockedNames.add(name);
    const file = join(cudaRuntimeVendorDir, name);
    if (!existsSync(file)) {
      failures.push(`${rel(file)}: missing locked CUDA runtime file`);
      continue;
    }
    if (typeof entry.sizeBytes === "number" && statSync(file).size !== entry.sizeBytes) {
      failures.push(`${rel(file)}: CUDA runtime size does not match lock`);
    }
    if (typeof entry.sha256 === "string" && fileSha256(file) !== entry.sha256.toLowerCase()) {
      failures.push(`${rel(file)}: CUDA runtime SHA-256 does not match lock`);
    }
  }

  for (const name of required) {
    if (!lockedNames.has(name)) {
      failures.push(`${rel(cudaRuntimeLock)}: required DLL ${name} is not listed in lock`);
    }
    if (!existsSync(join(cudaRuntimeVendorDir, name))) {
      failures.push(`${rel(join(cudaRuntimeVendorDir, name))}: missing required CUDA runtime DLL`);
    }
  }
}

function checkTauriConfigSeparation() {
  const flashConfig = readJson(tauriFlashConfig);
  const proConfig = readJson(tauriProConfig);

  if (flashConfig) {
    const flashText = JSON.stringify(flashConfig);
    for (const check of editionChecks.flash.forbidden) {
      if (check.pattern.test(flashText)) {
        failures.push(`src-tauri/tauri.flash.conf.json: contains ${check.label}`);
      }
    }
    if (/cuda-runtime|nvidia-cuda|onnxruntime_providers_cuda/i.test(flashText)) {
      failures.push("src-tauri/tauri.flash.conf.json: Flash must not bundle CUDA runtime resources");
    }
    if (flashConfig.bundle?.resources) {
      failures.push("src-tauri/tauri.flash.conf.json: Flash must not bundle RAW engine resources");
    }
  }

  if (edition === "pro") {
    const proText = JSON.stringify(proConfig ?? {});
    if (!/raw-engines\/rawtherapee/i.test(proText)) {
      failures.push("src-tauri/tauri.pro.conf.json: missing Pro bundled RawTherapee resource mapping");
    }
    for (const [path, label] of [
      [rawTherapeeCli, "bundled rawtherapee-cli.exe"],
      [rawTherapeeNotice, "RawTherapee third-party notice"],
      [rawTherapeeManifest, "RawTherapee version manifest"],
    ]) {
      if (!existsSync(path)) {
        failures.push(`${rel(path)}: missing ${label}`);
      }
    }
    if (existsSync(rawTherapeeManifest)) {
      const manifestText = readFileSync(rawTherapeeManifest, "utf8");
      if (!/a6de1797da462975435846db7b79a981557350af1bdac07525bf6884ede805dd/i.test(manifestText)) {
        failures.push("src-tauri/vendor/rawtherapee/rawtherapee-5.12-win64.json: missing pinned SHA-256");
      }
    }
    if (/cuda-runtime\/windows-x64\/runtime/i.test(proText)) {
      if (!/cuda-runtime\/windows-x64\/runtime-lock\.json/i.test(proText)) {
        failures.push("src-tauri/tauri.pro.conf.json: missing CUDA runtime lock resource mapping");
      }
      checkCudaRuntimeLock();
    }
  }
}

if (!existsSync(distDir)) {
  console.error("dist/ does not exist. Run pnpm run build first.");
  process.exit(1);
}

walk(distDir);
checkTauriConfigSeparation();

const allText = seenText.join("\n");
for (const check of activeEditionChecks.required) {
  if (!check.pattern.test(allText)) {
    failures.push(`dist/: missing ${check.label}`);
  }
}

if (failures.length > 0) {
  console.error(`Release artifact check failed for ${edition}:`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Release artifact check passed for ${edition}.`);
