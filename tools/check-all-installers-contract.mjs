import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const supportedEditions = new Set(["flash", "pro"]);
const supportedPlatforms = new Set(["windows", "macos"]);
const failures = [];

function fail(message) {
  failures.push(message);
}

function readText(path) {
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath)) {
    fail(`${path}: missing required file`);
    return "";
  }
  return readFileSync(absolutePath, "utf8");
}

function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch (error) {
    fail(`${path}: invalid JSON (${error.message})`);
    return {};
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--edition" && flag !== "--platform") throw new Error(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(flag)) throw new Error(`${flag} requires one value`);
    values.set(flag, value.toLowerCase());
    index += 1;
  }

  const edition = values.get("--edition");
  const platform = values.get("--platform");
  if (!supportedEditions.has(edition)) throw new Error("--edition must be flash or pro");
  if (!supportedPlatforms.has(platform)) throw new Error("--platform must be windows or macos");
  return { edition, platform };
}

function walkFrontend(path) {
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath)) return;
  for (const entry of readdirSync(absolutePath)) {
    const entryPath = resolve(absolutePath, entry);
    const entryStat = statSync(entryPath);
    const entryLabel = relative(root, entryPath).replaceAll("\\", "/");
    if (/beauty/i.test(entry)) {
      fail(`${entryLabel}: Beauty path is not allowed in a customer installer`);
    }
    if (entryStat.isDirectory()) {
      walkFrontend(entryLabel);
      continue;
    }
    if (!/\.(?:ts|tsx|js|jsx|css|html|json)$/i.test(entry)) continue;
    if (/beauty|美颜/i.test(readFileSync(entryPath, "utf8"))) {
      fail(`${entryLabel}: Beauty code, UI, or copy is not allowed in a customer installer`);
    }
  }
}

let input;
try {
  input = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`All-installers contract argument error: ${error.message}`);
  process.exit(1);
}

const packageJson = readJson("package.json");
const scripts = packageJson.scripts ?? {};
const expectedScripts = {
  "build:flash": "cross-env FRAMECULL_EDITION=FLASH",
  "build:pro": "cross-env FRAMECULL_EDITION=PRO",
  "build:release:flash": "tools/check-release-artifacts.mjs --edition flash",
  "build:release:pro": "tools/check-release-artifacts.mjs --edition pro",
  "build:release:pro:macos": "tools/check-release-artifacts.mjs --edition pro --target-platform macos",
};
for (const [name, fragment] of Object.entries(expectedScripts)) {
  if (typeof scripts[name] !== "string" || !scripts[name].includes(fragment)) {
    fail(`package.json: ${name} must include ${fragment}`);
  }
}

const configPath = input.edition === "flash"
  ? "src-tauri/tauri.flash.conf.json"
  : input.platform === "windows"
    ? "src-tauri/tauri.pro.conf.json"
    : "src-tauri/tauri.pro.macos.conf.json";
const config = readJson(configPath);
const expectedName = input.edition === "flash" ? "FrameCull AI Flash" : "FrameCull AI Pro";
const expectedIdentifier = input.edition === "flash" ? "com.framecull.ai.flash" : "com.framecull.ai.pro";
const expectedBeforeBuild = input.edition === "flash"
  ? "pnpm run build:release:flash"
  : input.platform === "windows"
    ? "pnpm run build:release:pro"
    : "pnpm run build:release:pro:macos";
if (config.productName !== expectedName) fail(`${configPath}: unexpected productName`);
if (config.identifier !== expectedIdentifier) fail(`${configPath}: unexpected identifier`);
if (config.build?.beforeBuildCommand !== expectedBeforeBuild) fail(`${configPath}: unexpected beforeBuildCommand`);
if (input.edition === "flash" && config.bundle?.resources) {
  fail(`${configPath}: Flash must not declare Pro-only bundle resources`);
}

if (input.edition === "pro" && input.platform === "windows") {
  const rawEngine = "vendor/rawtherapee/windows-x64/RawTherapee_5.12_win64_release";
  if (config.bundle?.resources?.[rawEngine] !== "raw-engines/rawtherapee/windows-x64/RawTherapee_5.12_win64_release") {
    fail(`${configPath}: missing bundled Windows RawTherapee mapping`);
  }
  const manifestPath = "src-tauri/vendor/rawtherapee/rawtherapee-5.12-win64.json";
  const manifest = readJson(manifestPath);
  if (manifest.platform !== "windows-x64") fail(`${manifestPath}: unexpected platform`);
  if (manifest.artifact !== "RawTherapee_5.12_win64_release.zip") fail(`${manifestPath}: unexpected artifact`);
  if (!/^https:\/\/github\.com\/RawTherapee\/RawTherapee\/releases\/download\//.test(manifest.sourceUrl ?? "")) {
    fail(`${manifestPath}: sourceUrl must be an official RawTherapee release`);
  }
  if (manifest.sha256 !== "a6de1797da462975435846db7b79a981557350af1bdac07525bf6884ede805dd") {
    fail(`${manifestPath}: unexpected archive SHA256`);
  }
  if (manifest.cliRelativePath !== "windows-x64/RawTherapee_5.12_win64_release/rawtherapee-cli.exe") {
    fail(`${manifestPath}: unexpected CLI path`);
  }
}

if (input.edition === "pro" && input.platform === "macos") {
  const manifestPath = "src-tauri/vendor/rawtherapee/rawtherapee-5.12-macos-universal.json";
  const manifest = readJson(manifestPath);
  const configResources = config.bundle?.resources ?? {};
  const rawApp = "vendor/rawtherapee/macos-universal/RawTherapee.app";
  if (configResources[rawApp] !== "raw-engines/rawtherapee/macos-universal/RawTherapee.app") {
    fail(`${configPath}: missing bundled macOS RawTherapee.app mapping`);
  }
  if (manifest.artifact !== "RawTherapee_macOS_15.4_Universal_5.12.zip") {
    fail(`${manifestPath}: unexpected artifact`);
  }
  if (!/^https:\/\/github\.com\/RawTherapee\/RawTherapee\/releases\/download\//.test(manifest.sourceUrl ?? "")) {
    fail(`${manifestPath}: sourceUrl must be an official RawTherapee release`);
  }
  if (manifest.sha256 !== "2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688") {
    fail(`${manifestPath}: unexpected archive SHA256`);
  }
}

for (const path of ["src", "public"]) walkFrontend(path);

if (failures.length > 0) {
  console.error("All-installers build contract failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`All-installers build contract passed for ${input.edition}/${input.platform}.`);
