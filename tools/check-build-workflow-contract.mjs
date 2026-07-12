import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflowPath = ".github/workflows/build.yml";
const workflow = readFileSync(resolve(root, workflowPath), "utf8");
const failures = [];

for (const required of [
  "name: Validate build workflow contract",
  "node tools/check-build-workflow-contract.mjs",
  "name: Configure signing environment",
  "APPLE_CERTIFICATE_SECRET: ${{ secrets.APPLE_CERTIFICATE }}",
  'if [[ "${RUNNER_OS}" == "macOS" && -z "${APPLE_CERTIFICATE_SECRET}" ]]; then',
  'printf \'APPLE_SIGNING_IDENTITY=-\\n\' >> "${GITHUB_ENV}"',
]) {
  if (!workflow.includes(required)) {
    failures.push(`${workflowPath}: missing ${required}`);
  }
}

for (const forbidden of [
  "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
  "APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}",
  "APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}",
  "APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}",
  "APPLE_ID: ${{ secrets.APPLE_ID }}",
  "APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}",
  "APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}",
]) {
  if (workflow.includes(forbidden)) {
    failures.push(`${workflowPath}: signing secret exported unconditionally: ${forbidden}`);
  }
}

const validationIndex = workflow.indexOf("name: Validate build workflow contract");
const configureIndex = workflow.indexOf("name: Configure signing environment");
const buildIndex = workflow.indexOf("name: Build Tauri app");
if (
  validationIndex < 0 ||
  configureIndex < 0 ||
  buildIndex < 0 ||
  !(validationIndex < configureIndex && configureIndex < buildIndex)
) {
  failures.push(`${workflowPath}: validate and configure signing before the Tauri build`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`ERROR: ${failure}`);
  }
  process.exit(1);
}

console.log("Build workflow signing contract: PASS");
