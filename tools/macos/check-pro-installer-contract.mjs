import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const mode = process.argv[2] ?? "--source";
const failures = [];

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function requireFile(relativePath) {
  if (!existsSync(resolve(root, relativePath))) {
    failures.push(`${relativePath}: missing`);
    return null;
  }
  return read(relativePath);
}

function requireStrings(relativePath, source, requiredStrings) {
  if (source === null) return;
  for (const required of requiredStrings) {
    if (!source.includes(required)) {
      failures.push(`${relativePath}: missing ${required}`);
    }
  }
}

if (mode === "--source") {
  const scriptPath = "tools/macos/FrameCull-Pro-Install.command";
  const readmePath = "tools/macos/README-FrameCull-Pro-macOS-first-launch.txt";
  const oldHelperPath = "tools/macos/FrameCull-Pro-First-Launch.command";
  const script = requireFile(scriptPath);
  const readme = requireFile(readmePath);

  requireStrings(scriptPath, script, [
    "VERIFY_ONLY",
    "UPDATE_FRAMECULL_ONLY",
    "REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL",
    "/Applications/FrameCull AI Pro.app",
    "/Applications/RawTherapee.app",
    "Application Support/com.framecull.ai.pro/tools/rawtherapee-cli",
    "2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688",
    "with administrator privileges",
    "--verify-only",
    "run_hdiutil",
    "read_plist_value",
    "read_plist_path_value",
    "validate_plist",
    "read_plist_type",
    "plist_key_exists",
    "read_plist_array_count",
    "parse_plist_devices",
    "normalize_disk_root",
    "/usr/bin/xmllint --xpath",
    "hdiutil info -plist",
    'image_path="images.${image_index}"',
    'image_filter="${2:-}"',
    'image-path',
    'entities_path="${image_path}.system-entities"',
    "build_frame_only_transaction_shell",
    "build_frame_and_raw_transaction_shell",
    "terminate_active_cli",
    "ACTIVE_CLI_PID",
    "ACTIVE_CLI_TREE_PIDS",
    "ACTIVE_CLI_OUTPUT_PATH",
    "CLI_VERSION_OUTPUT",
    "ACTIVE_CLI_FATAL_EXIT_STATUS",
    "/usr/bin/pgrep -P",
    "/bin/kill -STOP",
    "/bin/kill -KILL",
    'wait "${active_pid}"',
    "is_rawtherapee_version_output",
    "RawTherapee, version ",
    "open_frame_app",
    "/usr/bin/env -i /bin/sh -c",
  ]);

  if (script !== null) {
    for (const forbidden of [
      { label: "sudo", pattern: /\bsudo\b/i },
      { label: "eval", pattern: /\beval\b/ },
      { label: "setsid", pattern: /\bsetsid\b/ },
      { label: "setopt monitor", pattern: /setopt\s+[^\n#]*\bmonitor\b/ },
      { label: "ACTIVE_CLI_PGID", pattern: /\bACTIVE_CLI_PGID\b/ },
      { label: "process_group_exists", pattern: /\bprocess_group_exists\b/ },
      { label: "negative PGID kill", pattern: /\/bin\/kill\s+-[A-Z]+\s+--\s+"-\$\{[^}]+\}"/ },
      { label: "negative PGID poll", pattern: /\/bin\/kill\s+-0\s+--\s+"-\$\{[^}]+\}"/ },
      { label: "spctl --master-disable", pattern: /spctl\s+--master-disable/ },
      { label: "ditto env override", pattern: /FRAMECULL_INSTALLER_DITTO_BIN/ },
      { label: "xattr env override", pattern: /FRAMECULL_INSTALLER_XATTR_BIN/ },
      { label: "mktemp env override", pattern: /FRAMECULL_INSTALLER_MKTEMP_BIN/ },
      { label: "dirname env override", pattern: /FRAMECULL_INSTALLER_DIRNAME_BIN/ },
      { label: "rm env override", pattern: /FRAMECULL_INSTALLER_RM_BIN/ },
      { label: "mv env override", pattern: /FRAMECULL_INSTALLER_MV_BIN/ },
      { label: "kill env override", pattern: /FRAMECULL_INSTALLER_KILL_BIN/ },
      { label: "test signal checkpoint", pattern: /FRAMECULL_INSTALLER_TEST_SIGNAL_CHECKPOINT/ },
      { label: "checkpoint hook", pattern: /checkpoint\(\)/ },
      { label: "run_cli command substitution", pattern: /version_output="\$\(run_cli_version_with_timeout/ },
      { label: "find_healthy command substitution", pattern: /healthy_cli="\$\(find_healthy_rawtherapee_cli/ },
    ]) {
      if (forbidden.pattern.test(script)) {
        failures.push(`${scriptPath}: forbidden ${forbidden.label}`);
      }
    }

    const hdiutilCalls = script.match(/\/usr\/bin\/hdiutil/g) ?? [];
    const plutilCalls = script.match(/\/usr\/bin\/plutil/g) ?? [];
    const openCalls = script.match(/\/usr\/bin\/open/g) ?? [];
    if (hdiutilCalls.length !== 1) {
      failures.push(`${scriptPath}: hdiutil must only be called by run_hdiutil`);
    }
    if (plutilCalls.length !== 5) {
      failures.push(`${scriptPath}: plutil calls must stay inside the five structured plist helpers`);
    }
    if (openCalls.length !== 1) {
      failures.push(`${scriptPath}: open must only be called by open_frame_app`);
    }

    const runModeIndex = script.indexOf('run_install_for_mode "${mode}"');
    const cleanupIndex = script.indexOf("if ! cleanup; then", runModeIndex);
    const clearZerrIndex = script.indexOf("trap - ZERR", cleanupIndex);
    const clearExitIndex = script.indexOf("trap - EXIT", clearZerrIndex);
    const openIndex = script.indexOf('open_frame_app "${FRAME_APP}"', clearExitIndex);
    if (
      runModeIndex < 0 ||
      cleanupIndex < 0 ||
      clearZerrIndex < 0 ||
      clearExitIndex < 0 ||
      openIndex < 0 ||
      !(runModeIndex < cleanupIndex && cleanupIndex < clearZerrIndex && clearZerrIndex < clearExitIndex && clearExitIndex < openIndex)
    ) {
      failures.push(`${scriptPath}: FrameCull must open only after successful cleanup and cleared traps`);
    }

    const attachIndex = script.indexOf("attach_dmg_readonly() {");
    const beforeInfoIndex = script.indexOf('run_hdiutil info -plist >"${before_info_plist}"', attachIndex);
    const attachCallIndex = script.indexOf("run_hdiutil attach -readonly", attachIndex);
    const afterInfoIndex = script.indexOf('run_hdiutil info -plist >"${after_info_plist}"', attachCallIndex);
    const registerDeviceIndex = script.indexOf('MOUNTED_DEVICES+=("${new_devices[@]}")', attachIndex);
    const assertMountIndex = script.indexOf('if (( ${#mount_points[@]} != 1 )); then', attachIndex);
    if (
      attachIndex < 0 ||
      beforeInfoIndex < 0 ||
      attachCallIndex < 0 ||
      afterInfoIndex < 0 ||
      registerDeviceIndex < 0 ||
      assertMountIndex < 0 ||
      !(
        attachIndex < beforeInfoIndex &&
        beforeInfoIndex < attachCallIndex &&
        attachCallIndex < afterInfoIndex &&
        afterInfoIndex < registerDeviceIndex &&
        registerDeviceIndex < assertMountIndex
      )
    ) {
      failures.push(`${scriptPath}: attach must diff structured before/after device state before mount validation`);
    }

    const cleanupStart = script.indexOf("cleanup() {");
    const cleanupEnd = script.indexOf("handle_failure() {", cleanupStart);
    const cleanupBody = script.slice(cleanupStart, cleanupEnd);
    if (!cleanupBody.includes("terminate_active_cli")) {
      failures.push(`${scriptPath}: cleanup must terminate the active CLI process tree`);
    }
    if (!cleanupBody.includes("ACTIVE_CLI_TREE_PIDS=()")) {
      failures.push(`${scriptPath}: cleanup must clear the active CLI tree after success`);
    }
    if (!cleanupBody.includes('ACTIVE_CLI_OUTPUT_PATH=""')) {
      failures.push(`${scriptPath}: cleanup must clear the active CLI output path`);
    }
    if (script.includes('[[ "${version_output}" == *RawTherapee* ]]')) {
      failures.push(`${scriptPath}: RawTherapee health must not use a broad substring match`);
    }
    if (script.includes("[0-9]* ]] && return 0")) {
      failures.push(`${scriptPath}: RawTherapee version check must reject trailing non-version prose`);
    }

    const updateStart = script.indexOf("install_frame_only() {");
    const updateEnd = script.indexOf("repair_rawtherapee_and_install_frame() {", updateStart);
    const updateBody = script.slice(updateStart, updateEnd);
    for (const forbiddenCall of [
      "extract_rawtherapee_payload",
      "install_frame_and_raw_privileged",
      "install_cli_for_user",
      "RAW_PAYLOAD_DMG",
    ]) {
      if (updateBody.includes(forbiddenCall)) {
        failures.push(`${scriptPath}: UPDATE must not reference ${forbiddenCall}`);
      }
    }

    const verifyOnlyIndex = script.indexOf('if [[ "${ACTIVE_MODE}" == "${MODE_VERIFY_ONLY}" ]]');
    const determineModeIndex = script.indexOf("determine_install_mode", verifyOnlyIndex);
    const verifyOnlyBody = script.slice(verifyOnlyIndex, determineModeIndex);
    const verifyCleanupIndex = script.indexOf("if ! cleanup; then", verifyOnlyIndex);
    const verifyPassIndex = script.indexOf("Package checks and RawTherapee payload verification passed.", verifyOnlyIndex);
    if (
      verifyOnlyIndex < 0 ||
      verifyCleanupIndex < 0 ||
      verifyPassIndex < 0 ||
      !(verifyOnlyIndex < verifyCleanupIndex && verifyCleanupIndex < verifyPassIndex)
    ) {
      failures.push(`${scriptPath}: verify-only PASS must follow successful cleanup`);
    }
    for (const forbiddenCall of [
      "attach_dmg_readonly",
      "install_frame_only_privileged",
      "install_frame_and_raw_privileged",
      "install_cli_for_user",
      "open_frame_app",
    ]) {
      if (verifyOnlyBody.includes(forbiddenCall)) {
        failures.push(`${scriptPath}: VERIFY_ONLY must not reference ${forbiddenCall}`);
      }
    }

    if (!script.includes("cleanup || :")) {
      failures.push(`${scriptPath}: failure handler must use best-effort cleanup`);
    }

    if (!script.includes('device="$(normalize_disk_root "${device}")"')) {
      failures.push(`${scriptPath}: attach devices must be normalized to whole-disk roots`);
    }
    if (!script.includes('parse_plist_devices "${before_info_plist}" "${dmg}"') || !script.includes('parse_plist_devices "${after_info_plist}" "${dmg}"')) {
      failures.push(`${scriptPath}: fallback hdiutil info parsing must be scoped to the target image path`);
    }
    if (!script.includes('if (( ${#new_devices[@]} != 1 )); then')) {
      failures.push(`${scriptPath}: each attach must register exactly one new root device`);
    }

    const terminateStart = script.indexOf("terminate_active_cli() {");
    const pauseStart = script.indexOf("pause_if_interactive() {", terminateStart);
    const terminateBody = script.slice(terminateStart, pauseStart);
    const rootStopIndex = terminateBody.indexOf('/bin/kill -STOP "${active_pid}"');
    const childScanIndex = terminateBody.indexOf('/usr/bin/pgrep -P "${parent_pid}"');
    const childStopIndex = terminateBody.indexOf('/bin/kill -STOP "${child_pid}"');
    const childRecordIndex = terminateBody.indexOf('active_cli_tree_record_pid "${child_pid}"');
    const killIndex = terminateBody.indexOf('/bin/kill -KILL "${tree_pid}"');
    const waitIndex = terminateBody.indexOf('wait "${active_pid}"');
    const survivorPollIndex = terminateBody.indexOf('if active_cli_tree_has_live_pids');
    if (
      terminateStart < 0 ||
      pauseStart < 0 ||
      rootStopIndex < 0 ||
      childScanIndex < 0 ||
      childStopIndex < 0 ||
      childRecordIndex < 0 ||
      killIndex < 0 ||
      waitIndex < 0 ||
      survivorPollIndex < 0 ||
      !(rootStopIndex < childScanIndex && rootStopIndex < childStopIndex && childStopIndex < childRecordIndex && childRecordIndex < killIndex && killIndex < waitIndex && waitIndex < survivorPollIndex)
    ) {
      failures.push(`${scriptPath}: timeout cleanup must freeze before discovery, then KILL, wait, and poll survivors`);
    }

    const cleanupSuccessGuardIndex = cleanupBody.indexOf("if (( active_cli_cleanup_ok == 1 )); then");
    const cleanupOutputClearIndex = cleanupBody.indexOf('ACTIVE_CLI_OUTPUT_PATH=""');
    const cleanupWorkDirIndex = cleanupBody.indexOf('if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then');
    if (
      cleanupSuccessGuardIndex < 0 ||
      cleanupOutputClearIndex < 0 ||
      cleanupWorkDirIndex < 0 ||
      !(cleanupSuccessGuardIndex < cleanupOutputClearIndex && cleanupSuccessGuardIndex < cleanupWorkDirIndex)
    ) {
      failures.push(`${scriptPath}: cleanup must only clear active CLI output state and WORK_DIR after terminate_active_cli succeeds`);
    }

    const runCliStart = script.indexOf("run_cli_version_with_timeout() {");
    const runCliEnd = script.indexOf("is_rawtherapee_version_output() {", runCliStart);
    const runCliBody = script.slice(runCliStart, runCliEnd);
    const staleGuardIndex = runCliBody.indexOf('if [[ -n "${ACTIVE_CLI_PID}" || ${#ACTIVE_CLI_TREE_PIDS[@]} -gt 0 || -n "${ACTIVE_CLI_OUTPUT_PATH}" ]]; then');
    const mktempIndex = runCliBody.indexOf('ACTIVE_CLI_OUTPUT_PATH="$(/usr/bin/mktemp');
    const fatalTimeoutIndex = runCliBody.indexOf('terminate_active_cli || return "${ACTIVE_CLI_FATAL_EXIT_STATUS}"');
    const versionOutputSetIndex = runCliBody.indexOf('CLI_VERSION_OUTPUT="${output}"');
    if (
      runCliStart < 0 ||
      runCliEnd < 0 ||
      staleGuardIndex < 0 ||
      mktempIndex < 0 ||
      fatalTimeoutIndex < 0 ||
      versionOutputSetIndex < 0 ||
      !(staleGuardIndex < mktempIndex && mktempIndex < fatalTimeoutIndex && fatalTimeoutIndex < versionOutputSetIndex)
    ) {
      failures.push(`${scriptPath}: run_cli_version_with_timeout must guard stale active state, preserve fatal cleanup state, and publish CLI_VERSION_OUTPUT directly`);
    }

    const findHealthyStart = script.indexOf("find_healthy_rawtherapee_cli() {");
    const determineStart = script.indexOf("determine_install_mode() {", findHealthyStart);
    const findHealthyBody = script.slice(findHealthyStart, determineStart);
    const directRunCliIndex = findHealthyBody.indexOf('if run_cli_version_with_timeout "${candidate}" 10; then');
    const directCliOutputIndex = findHealthyBody.indexOf('is_rawtherapee_version_output "${CLI_VERSION_OUTPUT}"');
    const fatalRunStatusIndex = findHealthyBody.indexOf('if (( run_status == ACTIVE_CLI_FATAL_EXIT_STATUS )); then');
    const fatalReturnIndex = findHealthyBody.indexOf('return "${ACTIVE_CLI_FATAL_EXIT_STATUS}"');
    if (
      findHealthyStart < 0 ||
      determineStart < 0 ||
      directRunCliIndex < 0 ||
      directCliOutputIndex < 0 ||
      fatalRunStatusIndex < 0 ||
      fatalReturnIndex < 0 ||
      !(directRunCliIndex < directCliOutputIndex && directCliOutputIndex < fatalRunStatusIndex && fatalRunStatusIndex < fatalReturnIndex)
    ) {
      failures.push(`${scriptPath}: find_healthy_rawtherapee_cli must call run_cli directly, consume CLI_VERSION_OUTPUT, and propagate fatal cleanup status`);
    }

    const determineEnd = script.indexOf("extract_rawtherapee_payload() {", determineStart);
    const determineBody = script.slice(determineStart, determineEnd);
    const directFindHealthyIndex = determineBody.indexOf('if find_healthy_rawtherapee_cli "${raw_app}" "$@"; then');
    const determineFatalIndex = determineBody.indexOf('if (( determine_status == ACTIVE_CLI_FATAL_EXIT_STATUS )); then');
    const determineRepairIndex = determineBody.indexOf('INSTALL_MODE="${MODE_REPAIR}"');
    if (
      determineStart < 0 ||
      determineEnd < 0 ||
      directFindHealthyIndex < 0 ||
      determineFatalIndex < 0 ||
      determineRepairIndex < 0 ||
      !(directFindHealthyIndex < determineFatalIndex && determineFatalIndex < determineRepairIndex)
    ) {
      failures.push(`${scriptPath}: determine_install_mode must call find_healthy directly and return fatal status before considering REPAIR`);
    }

    const frameBuilderStart = script.indexOf("build_frame_only_transaction_shell() {");
    const combinedBuilderStart = script.indexOf("build_frame_and_raw_transaction_shell() {", frameBuilderStart);
    const framePrivilegedStart = script.indexOf("install_frame_only_privileged() {", combinedBuilderStart);
    const combinedPrivilegedStart = script.indexOf("install_frame_and_raw_privileged() {", combinedBuilderStart);
    const cliInstallStart = script.indexOf("install_cli_for_user() {", combinedPrivilegedStart);
    const frameBuilderBody = script.slice(frameBuilderStart, combinedBuilderStart);
    const framePrivilegedBody = script.slice(framePrivilegedStart, combinedPrivilegedStart);
    const combinedBuilderBody = script.slice(combinedBuilderStart, combinedPrivilegedStart);
    const combinedPrivilegedBody = script.slice(combinedPrivilegedStart, cliInstallStart);
    const privilegedBodies = [
      ["Frame-only", frameBuilderBody],
      ["Combined", combinedBuilderBody],
    ];
    for (const [label, body] of privilegedBodies) {
      if (body.includes('/bin/rm -rf "$frameTarget"') || body.includes('/bin/rm -rf "${frameTarget}"')) {
        failures.push(`${scriptPath}: ${label} privileged install must not remove FrameCull before ditto to target`);
      }
      if (body.includes('/bin/rm -rf "$rawTarget"') || body.includes('/bin/rm -rf "${rawTarget}"')) {
        failures.push(`${scriptPath}: ${label} privileged install must not remove RawTherapee before ditto to target`);
      }
      for (const required of [
        "trap rollback EXIT HUP INT TERM",
        'rollback_path()',
        '/usr/bin/ditto "$frameSource" "$frameStage"',
        '/bin/mv "$frameStage" "$frameTarget"',
      ]) {
        if (!body.includes(required)) {
          failures.push(`${scriptPath}: ${label} transaction builder missing rollback marker ${required}`);
        }
      }
    }
    for (const required of [
      '/usr/bin/ditto "$rawSource" "$rawStage"',
      '/bin/mv "$rawStage" "$rawTarget"',
    ]) {
      if (!combinedBuilderBody.includes(required)) {
        failures.push(`${scriptPath}: Combined privileged install missing rollback marker ${required}`);
      }
    }
    const stageFrameIndex = combinedBuilderBody.indexOf('/usr/bin/ditto "$frameSource" "$frameStage"');
    const stageRawIndex = combinedBuilderBody.indexOf('/usr/bin/ditto "$rawSource" "$rawStage"');
    const replaceFrameIndex = combinedBuilderBody.indexOf('/bin/mv "$frameStage" "$frameTarget"');
    const replaceRawIndex = combinedBuilderBody.indexOf('/bin/mv "$rawStage" "$rawTarget"');
    if (
      stageFrameIndex < 0 ||
      stageRawIndex < 0 ||
      replaceFrameIndex < 0 ||
      replaceRawIndex < 0 ||
      !(stageFrameIndex < stageRawIndex && stageRawIndex < replaceFrameIndex && replaceFrameIndex < replaceRawIndex)
    ) {
      failures.push(`${scriptPath}: combined privileged install must stage both apps before replacing fixed targets`);
    }
    const rawRollbackIndex = combinedBuilderBody.indexOf('rollback_path "$rawTarget" "$rawStage" "$rawBackup"');
    const frameRollbackIndex = combinedBuilderBody.indexOf('rollback_path "$frameTarget" "$frameStage" "$frameBackup"');
    if (rawRollbackIndex < 0 || frameRollbackIndex < 0 || !(rawRollbackIndex < frameRollbackIndex)) {
      failures.push(`${scriptPath}: combined transaction rollback must restore RawTherapee before FrameCull`);
    }
    for (const forbidden of [
      "restoreFrame",
      "restoreRaw",
      "frameInstalled",
      "rawInstalled",
    ]) {
      if (frameBuilderBody.includes(forbidden) || combinedBuilderBody.includes(forbidden) || framePrivilegedBody.includes(forbidden) || combinedPrivilegedBody.includes(forbidden)) {
        failures.push(`${scriptPath}: filesystem-derived rollback must not depend on ${forbidden}`);
      }
    }
    if (!framePrivilegedBody.includes('/usr/bin/env -i /bin/sh -c') || !combinedPrivilegedBody.includes('/usr/bin/env -i /bin/sh -c')) {
      failures.push(`${scriptPath}: privileged installers must execute transaction strings via /usr/bin/env -i /bin/sh -c`);
    }
  }

  requireStrings(readmePath, readme, [
    "FrameCull-Pro-Install.command",
    "/bin/zsh ",
    "后续更新",
    "只更新 FrameCull",
  ]);

  if (existsSync(resolve(root, oldHelperPath))) {
    failures.push("old Pro first-launch helper still exists");
  }
} else if (mode === "--workflow") {
  const workflowPath = ".github/workflows/macos-pro-test-build.yml";
  const workflow = requireFile(workflowPath);

  requireStrings(workflowPath, workflow, [
    "FrameCull-Pro-Install.command",
    "FrameCull-Pro-Install.test.zsh",
    "check-pro-installer-contract.mjs --workflow",
    "--verify-only",
  ]);

  if (workflow?.includes("FrameCull-Pro-First-Launch.command")) {
    failures.push(`${workflowPath}: old helper reference remains`);
  }
} else {
  failures.push(`unknown mode: ${mode}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`macOS Pro installer contract ${mode}: PASS`);
