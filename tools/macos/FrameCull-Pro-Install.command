#!/bin/zsh
set -euo pipefail

readonly MODE_VERIFY_ONLY="VERIFY_ONLY"
readonly MODE_UPDATE="UPDATE_FRAMECULL_ONLY"
readonly MODE_REPAIR="REPAIR_RAWTHERAPEE_AND_UPDATE_FRAMECULL"
readonly RAWTHERAPEE_VERSION_HELP_EXIT_STATUS=255
readonly FRAME_APP="/Applications/FrameCull AI Pro.app"
readonly RAW_APP="/Applications/RawTherapee.app"
readonly RAW_ARCHIVE_NAME="RawTherapee_macOS_15.4_Universal_5.12.zip"
readonly RAW_ARCHIVE_SHA256="2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688"
readonly MANAGED_CLI="${HOME}/Library/Application Support/com.framecull.ai.pro/tools/rawtherapee-cli"
readonly SCRIPT_DIR="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
readonly RAW_ARCHIVE_PATH="${SCRIPT_DIR}/${RAW_ARCHIVE_NAME}"

typeset -a MOUNTED_DEVICES
MOUNTED_DEVICES=()
typeset -a PARSED_PLIST_DEVICES
PARSED_PLIST_DEVICES=()
typeset -a PARSED_ATTACH_MOUNT_POINTS
PARSED_ATTACH_MOUNT_POINTS=()
typeset -a PARSED_ATTACH_MOUNT_DEVICES
PARSED_ATTACH_MOUNT_DEVICES=()
typeset -gi ATTACH_COUNTER=0
WORK_DIR=""
FRAME_DMG=""
RAW_PAYLOAD_DIR=""
RAW_PAYLOAD_DMG=""
RAW_PAYLOAD_CLI=""
ATTACHED_MOUNT_POINT=""
CLI_TEMP_PATH=""
HEALTHY_RAW_CLI=""
INSTALL_MODE=""
ACTIVE_MODE=""
CLI_VERSION_OUTPUT=""
ACTIVE_CLI_PID=""
typeset -a ACTIVE_CLI_TREE_PIDS
ACTIVE_CLI_TREE_PIDS=()
ACTIVE_CLI_OUTPUT_PATH=""
readonly ACTIVE_CLI_FATAL_EXIT_STATUS=125
readonly ACTIVE_CLI_TREE_FREEZE_MAX_PASSES=40
readonly ACTIVE_CLI_TREE_MAX_NODES=256
readonly ACTIVE_CLI_TREE_POLL_ATTEMPTS=40

fail() {
  print -u2 -r -- "$1"
  print -u2 -r -- "$2"
  return 1
}

verify_frame_signature() {
  /usr/bin/codesign --verify --deep --strict "$1"
}

open_frame_app() {
  /usr/bin/open "$1"
}

run_hdiutil() {
  /usr/bin/hdiutil "$@"
}

read_plist_value() {
  local plist="$1"
  local index="$2"
  local key="$3"
  read_plist_path_value "${plist}" "system-entities.${index}.${key}"
}

read_plist_path_value() {
  local plist="$1"
  local key_path="$2"
  /usr/bin/plutil -extract "${key_path}" raw -o - "${plist}" 2>/dev/null
}

validate_plist() {
  /usr/bin/plutil -lint "$1" >/dev/null 2>&1
}

normalize_attach_plist_output() {
  local plist="$1"
  local normalized="${plist}.normalized"
  local line
  local found_start=0
  local found_end=0

  if validate_plist "${plist}"; then
    return 0
  fi
  : >"${normalized}" || return 1
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if (( found_start == 0 )); then
      [[ "${line}" == '<?xml '* ]] || continue
      found_start=1
    fi
    /usr/bin/printf '%s\n' "${line}" >>"${normalized}" || {
      /bin/rm -f -- "${normalized}"
      return 1
    }
    if [[ "${line}" == '</plist>' ]]; then
      found_end=1
      break
    fi
  done <"${plist}"
  if (( found_start == 0 || found_end == 0 )) || ! validate_plist "${normalized}"; then
    /bin/rm -f -- "${normalized}"
    return 1
  fi
  /bin/mv -f -- "${normalized}" "${plist}"
}

read_plist_type() {
  local plist="$1"
  local key_path="$2"
  /usr/bin/plutil -type "${key_path}" "${plist}" 2>/dev/null
}

plist_key_exists() {
  local plist="$1"
  local key_path="$2"
  /usr/bin/plutil -type "${key_path}" "${plist}" >/dev/null 2>&1
}

read_plist_array_count() {
  local plist="$1"
  local key_path="$2"
  /usr/bin/plutil -extract "${key_path}" xml1 -o - "${plist}" 2>/dev/null |
    /usr/bin/xmllint --xpath 'count(/plist/array/*)' - 2>/dev/null
}

array_contains() {
  local needle="$1"
  local candidate
  shift
  for candidate in "$@"; do
    [[ "${candidate}" == "${needle}" ]] && return 0
  done
  return 1
}

normalize_disk_root() {
  local device="$1"

  if [[ "${device}" =~ '^/dev/(disk[0-9]+)(s[0-9].*)?$' ]]; then
    print -r -- "/dev/${match[1]}"
  else
    print -r -- "${device}"
  fi
}

parse_plist_devices() {
  local plist="$1"
  local image_filter="${2:-}"
  local image_index image_count image_path current_image_path entities_path entities_type
  local entity_index entity_count entity_path device mount_point
  local images_type

  PARSED_PLIST_DEVICES=()
  PARSED_ATTACH_MOUNT_POINTS=()
  PARSED_ATTACH_MOUNT_DEVICES=()
  validate_plist "${plist}" || return 1
  images_type="$(read_plist_type "${plist}" "images")" || return 1
  [[ "${images_type}" == "array" ]] || return 1
  image_count="$(read_plist_array_count "${plist}" "images")" || return 1
  [[ "${image_count}" == <-> ]] || return 1

  for (( image_index = 0; image_index < image_count; image_index++ )); do
    image_path="images.${image_index}"
    if [[ -n "${image_filter}" ]]; then
      plist_key_exists "${plist}" "${image_path}.image-path" || continue
      current_image_path="$(read_plist_path_value "${plist}" "${image_path}.image-path")" || return 1
      [[ "${current_image_path}" == "${image_filter}" ]] || continue
    fi
    entities_path="${image_path}.system-entities"
    plist_key_exists "${plist}" "${entities_path}" || continue
    entities_type="$(read_plist_type "${plist}" "${entities_path}")" || return 1
    [[ "${entities_type}" == "array" ]] || return 1
    entity_count="$(read_plist_array_count "${plist}" "${entities_path}")" || return 1
    [[ "${entity_count}" == <-> ]] || return 1
    for (( entity_index = 0; entity_index < entity_count; entity_index++ )); do
      entity_path="${entities_path}.${entity_index}"
      device=""
      if plist_key_exists "${plist}" "${entity_path}.dev-entry"; then
        device="$(read_plist_path_value "${plist}" "${entity_path}.dev-entry")" || return 1
        device="$(normalize_disk_root "${device}")"
        if ! array_contains "${device}" "${PARSED_PLIST_DEVICES[@]}"; then
          PARSED_PLIST_DEVICES+=("${device}")
        fi
      fi
      if [[ -n "${device}" ]] && plist_key_exists "${plist}" "${entity_path}.mount-point"; then
        if mount_point="$(read_plist_path_value "${plist}" "${entity_path}.mount-point")" &&
          [[ -n "${mount_point}" ]]; then
          PARSED_ATTACH_MOUNT_POINTS+=("${mount_point}")
          PARSED_ATTACH_MOUNT_DEVICES+=("${device}")
        fi
      fi
    done
  done
}

parse_attach_plist() {
  local plist="$1"
  local index entity_count entity_path device mount_point
  local entities_type

  PARSED_PLIST_DEVICES=()
  PARSED_ATTACH_MOUNT_POINTS=()
  PARSED_ATTACH_MOUNT_DEVICES=()
  validate_plist "${plist}" || return 1
  entities_type="$(read_plist_type "${plist}" "system-entities")" || return 1
  [[ "${entities_type}" == "array" ]] || return 1
  entity_count="$(read_plist_array_count "${plist}" "system-entities")" || return 1
  [[ "${entity_count}" == <-> ]] || return 1

  for (( index = 0; index < entity_count; index++ )); do
    entity_path="system-entities.${index}"
    device=""
    if plist_key_exists "${plist}" "${entity_path}.dev-entry"; then
      device="$(read_plist_value "${plist}" "${index}" "dev-entry")" || return 1
      device="$(normalize_disk_root "${device}")"
      if ! array_contains "${device}" "${PARSED_PLIST_DEVICES[@]}"; then
        PARSED_PLIST_DEVICES+=("${device}")
      fi
    fi
    if plist_key_exists "${plist}" "${entity_path}.mount-point"; then
      [[ -n "${device}" ]] || return 1
      mount_point="$(read_plist_value "${plist}" "${index}" "mount-point")" || return 1
      PARSED_ATTACH_MOUNT_POINTS+=("${mount_point}")
      PARSED_ATTACH_MOUNT_DEVICES+=("${device}")
    fi
  done
}

active_cli_pid_exists() {
  [[ -n "$1" ]] && /bin/kill -0 "$1" >/dev/null 2>&1
}

active_cli_tree_record_pid() {
  local candidate_pid="$1"

  [[ -n "${candidate_pid}" && "${candidate_pid}" == <-> ]] || return 1
  if array_contains "${candidate_pid}" "${ACTIVE_CLI_TREE_PIDS[@]}"; then
    return 1
  fi
  ACTIVE_CLI_TREE_PIDS+=("${candidate_pid}")
  return 0
}

active_cli_tree_has_live_pids() {
  local tree_pid

  for tree_pid in "${ACTIVE_CLI_TREE_PIDS[@]}"; do
    if active_cli_pid_exists "${tree_pid}"; then
      return 0
    fi
  done
  return 1
}

terminate_active_cli() {
  local active_pid="${ACTIVE_CLI_PID}"
  local attempt pass discovered_new=0 stable=0
  local tree_pid parent_pid child_pid
  local -a tree_snapshot

  if [[ -z "${active_pid}" ]]; then
    if (( ${#ACTIVE_CLI_TREE_PIDS[@]} == 0 )); then
      return 0
    fi
    active_pid="${ACTIVE_CLI_TREE_PIDS[1]}"
  fi

  if [[ -n "${ACTIVE_CLI_PID}" && ${#ACTIVE_CLI_TREE_PIDS[@]} == 0 ]]; then
    ACTIVE_CLI_TREE_PIDS=("${ACTIVE_CLI_PID}")
  fi

  if active_cli_pid_exists "${active_pid}"; then
    /bin/kill -STOP "${active_pid}" >/dev/null 2>&1 || {
      active_cli_pid_exists "${active_pid}" && return 1
    }
    for (( pass = 1; pass <= ACTIVE_CLI_TREE_FREEZE_MAX_PASSES; pass++ )); do
      discovered_new=0
      tree_snapshot=("${ACTIVE_CLI_TREE_PIDS[@]}")
      for parent_pid in "${tree_snapshot[@]}"; do
        while IFS= read -r child_pid; do
          [[ -n "${child_pid}" && "${child_pid}" == <-> ]] || continue
          if ! array_contains "${child_pid}" "${ACTIVE_CLI_TREE_PIDS[@]}"; then
            if /bin/kill -STOP "${child_pid}" >/dev/null 2>&1; then
              active_cli_tree_record_pid "${child_pid}" || :
              discovered_new=1
              if (( ${#ACTIVE_CLI_TREE_PIDS[@]} > ACTIVE_CLI_TREE_MAX_NODES )); then
                return 1
              fi
            fi
          fi
        done < <(/usr/bin/pgrep -P "${parent_pid}" 2>/dev/null || :)
      done
      if (( ${#ACTIVE_CLI_TREE_PIDS[@]} > ACTIVE_CLI_TREE_MAX_NODES )); then
        return 1
      fi
      if (( discovered_new == 0 )); then
        stable=1
        break
      fi
    done
    (( stable == 1 )) || return 1
  fi

  for (( attempt = ${#ACTIVE_CLI_TREE_PIDS[@]}; attempt >= 1; attempt-- )); do
    tree_pid="${ACTIVE_CLI_TREE_PIDS[attempt]}"
    /bin/kill -KILL "${tree_pid}" >/dev/null 2>&1 || :
  done
  wait "${active_pid}" >/dev/null 2>&1 || :
  for (( attempt = 1; attempt <= ACTIVE_CLI_TREE_POLL_ATTEMPTS; attempt++ )); do
    if ! active_cli_tree_has_live_pids; then
      ACTIVE_CLI_PID=""
      ACTIVE_CLI_TREE_PIDS=()
      return 0
    fi
    /bin/sleep 0.1
  done
  if active_cli_tree_has_live_pids; then
    return 1
  fi
  ACTIVE_CLI_PID=""
  ACTIVE_CLI_TREE_PIDS=()
}

pause_if_interactive() {
  if [[ -t 0 && -t 1 ]]; then
    print -r -- ""
    read -r "?按回车键关闭此窗口 / Press Return to close..." || :
  fi
}

cleanup() {
  local index device cleanup_failed=0 active_cli_cleanup_ok=0
  local -a remaining_devices

  remaining_devices=()

  if terminate_active_cli; then
    active_cli_cleanup_ok=1
  else
    cleanup_failed=1
  fi
  if (( active_cli_cleanup_ok == 1 )); then
    if [[ -n "${ACTIVE_CLI_OUTPUT_PATH}" && -e "${ACTIVE_CLI_OUTPUT_PATH}" ]]; then
      if /bin/rm -f -- "${ACTIVE_CLI_OUTPUT_PATH}" >/dev/null 2>&1; then
        ACTIVE_CLI_PID=""
        ACTIVE_CLI_TREE_PIDS=()
        ACTIVE_CLI_OUTPUT_PATH=""
      else
        cleanup_failed=1
      fi
    else
      ACTIVE_CLI_PID=""
      ACTIVE_CLI_TREE_PIDS=()
      ACTIVE_CLI_OUTPUT_PATH=""
    fi
  fi

  if [[ -n "${CLI_TEMP_PATH}" && -e "${CLI_TEMP_PATH}" ]]; then
    if /bin/rm -f -- "${CLI_TEMP_PATH}" >/dev/null 2>&1; then
      CLI_TEMP_PATH=""
    else
      cleanup_failed=1
    fi
  else
    CLI_TEMP_PATH=""
  fi

  for (( index = ${#MOUNTED_DEVICES[@]}; index >= 1; index-- )); do
    device="${MOUNTED_DEVICES[index]}"
    if ! run_hdiutil detach "${device}" >/dev/null 2>&1; then
      print -u2 -r -- "警告：无法卸载 ${device}。"
      print -u2 -r -- "Warning: could not detach ${device}."
      remaining_devices+=("${device}")
      cleanup_failed=1
    fi
  done
  MOUNTED_DEVICES=("${remaining_devices[@]}")

  if (( active_cli_cleanup_ok == 1 )); then
    if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
      if /bin/rm -rf -- "${WORK_DIR}" >/dev/null 2>&1; then
        WORK_DIR=""
      else
        cleanup_failed=1
      fi
    else
      WORK_DIR=""
    fi
  fi
  ATTACHED_MOUNT_POINT=""
  return "${cleanup_failed}"
}

handle_failure() {
  local exit_status="${1:-1}"
  trap - ZERR
  trap - EXIT
  print -u2 -r -- "安装未完成，FrameCull AI Pro 未启动。"
  print -u2 -r -- "Installation did not complete; FrameCull AI Pro was not opened."
  cleanup || :
  if [[ "${ACTIVE_MODE}" != "${MODE_VERIFY_ONLY}" ]]; then
    pause_if_interactive
  fi
  exit "${exit_status}"
}

verify_package_contract() {
  local checksum_path="${SCRIPT_DIR}/SHA256SUMS.txt"
  local readme_path="${SCRIPT_DIR}/README-FrameCull-Pro-macOS-first-launch.txt"
  local -a frame_dmgs

  [[ -f "${checksum_path}" ]] || fail \
    "缺少 SHA256SUMS.txt。" \
    "SHA256SUMS.txt is missing."
  [[ -f "${RAW_ARCHIVE_PATH}" ]] || fail \
    "缺少官方 RawTherapee 安装包：${RAW_ARCHIVE_NAME}" \
    "Official RawTherapee archive is missing: ${RAW_ARCHIVE_NAME}"
  [[ -f "${readme_path}" ]] || fail \
    "缺少安装说明。" \
    "Installer README is missing."

  frame_dmgs=("${SCRIPT_DIR}"/*.dmg(N))
  (( ${#frame_dmgs[@]} == 1 )) || fail \
    "安装包必须且只能包含一个 FrameCull DMG。" \
    "The package must contain exactly one FrameCull DMG."
  FRAME_DMG="${frame_dmgs[1]}"

  if ! (
    cd "${SCRIPT_DIR}" &&
    /usr/bin/shasum -a 256 --check SHA256SUMS.txt &&
    /usr/bin/printf '%s  %s\n' "${RAW_ARCHIVE_SHA256}" "${RAW_ARCHIVE_NAME}" |
      /usr/bin/shasum -a 256 --check
  ); then
    fail \
      "安装包校验失败，请重新下载官方测试包。" \
      "Package verification failed; download the official test package again."
  fi
}

run_cli_version_with_timeout() {
  local cli="$1"
  local seconds="$2"
  local temp_root="${WORK_DIR:-${TMPDIR:-/tmp}}"
  local output exit_status=0 elapsed=0
  local max_ticks=$(( seconds * 10 ))

  if [[ -n "${ACTIVE_CLI_PID}" || ${#ACTIVE_CLI_TREE_PIDS[@]} -gt 0 || -n "${ACTIVE_CLI_OUTPUT_PATH}" ]]; then
    return "${ACTIVE_CLI_FATAL_EXIT_STATUS}"
  fi

  CLI_VERSION_OUTPUT=""
  ACTIVE_CLI_OUTPUT_PATH="$(/usr/bin/mktemp "${temp_root}/framecull-rawtherapee-version.XXXXXX")"
  "${cli}" -v >"${ACTIVE_CLI_OUTPUT_PATH}" 2>&1 &
  ACTIVE_CLI_PID=$!
  ACTIVE_CLI_TREE_PIDS=("${ACTIVE_CLI_PID}")

  while /bin/kill -0 "${ACTIVE_CLI_PID}" >/dev/null 2>&1; do
    if (( elapsed >= max_ticks )); then
      terminate_active_cli || return "${ACTIVE_CLI_FATAL_EXIT_STATUS}"
      output="$(/bin/cat "${ACTIVE_CLI_OUTPUT_PATH}")"
      CLI_VERSION_OUTPUT="${output}"
      /bin/rm -f -- "${ACTIVE_CLI_OUTPUT_PATH}"
      ACTIVE_CLI_OUTPUT_PATH=""
      return 124
    fi
    /bin/sleep 0.1
    elapsed=$((elapsed + 1))
  done

  if wait "${ACTIVE_CLI_PID}"; then
    exit_status=0
  else
    exit_status=$?
  fi
  ACTIVE_CLI_PID=""
  ACTIVE_CLI_TREE_PIDS=()
  output="$(/bin/cat "${ACTIVE_CLI_OUTPUT_PATH}")"
  CLI_VERSION_OUTPUT="${output}"
  /bin/rm -f -- "${ACTIVE_CLI_OUTPUT_PATH}"
  ACTIVE_CLI_OUTPUT_PATH=""
  return "${exit_status}"
}

is_rawtherapee_version_output() {
  local output="$1"
  local line

  for line in "${(@f)output}"; do
    [[ "${line}" =~ '^RawTherapee, version [0-9]+([.][0-9]+)*([-+][[:alnum:]._-]+)?(, command line[.])?$' ]] && return 0
  done
  return 1
}

rawtherapee_version_probe_is_healthy() {
  local exit_status="$1"
  local output="$2"

  (( exit_status == 0 || exit_status == RAWTHERAPEE_VERSION_HELP_EXIT_STATUS )) || return 1
  is_rawtherapee_version_output "${output}"
}

find_healthy_rawtherapee_cli() {
  local app="$1"
  local candidate run_status
  shift

  HEALTHY_RAW_CLI=""
  [[ -d "${app}" ]] || return 1
  for candidate in "$@"; do
    [[ -x "${candidate}" ]] || continue
    if run_cli_version_with_timeout "${candidate}" 10; then
      run_status=0
    else
      run_status=$?
    fi
    if (( run_status == ACTIVE_CLI_FATAL_EXIT_STATUS )); then
      return "${ACTIVE_CLI_FATAL_EXIT_STATUS}"
    fi
    if rawtherapee_version_probe_is_healthy "${run_status}" "${CLI_VERSION_OUTPUT}"; then
      HEALTHY_RAW_CLI="${candidate}"
      return 0
    fi
  done
  return 1
}

determine_install_mode() {
  local raw_app="$1"
  local determine_status=0
  shift

  HEALTHY_RAW_CLI=""
  INSTALL_MODE=""
  if find_healthy_rawtherapee_cli "${raw_app}" "$@"; then
    determine_status=0
  else
    determine_status=$?
  fi
  if (( determine_status == 0 )); then
    INSTALL_MODE="${MODE_UPDATE}"
  else
    if (( determine_status == ACTIVE_CLI_FATAL_EXIT_STATUS )); then
      return "${determine_status}"
    fi
    INSTALL_MODE="${MODE_REPAIR}"
  fi
  print -r -- "${INSTALL_MODE}"
  return 0
}

extract_rawtherapee_payload() {
  [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]] || fail \
    "临时工作目录不可用。" \
    "Temporary work directory is unavailable."

  local extract_root="${WORK_DIR}/rawtherapee-extracted"
  RAW_PAYLOAD_DIR="${extract_root}/RawTherapee_macOS_15.4_Universal_5.12_folder"
  RAW_PAYLOAD_DMG="${RAW_PAYLOAD_DIR}/RawTherapee_macOS_15.4_Universal_5.12.dmg"
  RAW_PAYLOAD_CLI="${RAW_PAYLOAD_DIR}/rawtherapee-cli"
  local install_readme="${RAW_PAYLOAD_DIR}/install-readme.txt"

  /bin/mkdir -p "${extract_root}"
  if ! /usr/bin/ditto -x -k "${RAW_ARCHIVE_PATH}" "${extract_root}"; then
    fail \
      "无法解压官方 RawTherapee 安装包。" \
      "Could not extract the official RawTherapee archive."
  fi

  [[ -f "${RAW_PAYLOAD_DMG}" ]] || fail \
    "RawTherapee 归档缺少固定 DMG。" \
    "RawTherapee archive is missing the expected DMG."
  [[ -f "${RAW_PAYLOAD_CLI}" ]] || fail \
    "RawTherapee 归档缺少独立 CLI。" \
    "RawTherapee archive is missing the standalone CLI."
  [[ -f "${install_readme}" ]] || fail \
    "RawTherapee 归档缺少 install-readme.txt。" \
    "RawTherapee archive is missing install-readme.txt."
}

attach_dmg_readonly() {
  local dmg="$1"
  local plist before_info_plist after_info_plist device mount_device cleanup_device="" primary_parse_ok=0 mount_device_is_new=0
  local -a before_devices attached_devices mount_points mount_devices new_devices

  [[ -f "${dmg}" ]] || fail \
    "找不到磁盘映像：${dmg}" \
    "Disk image not found: ${dmg}"
  ATTACH_COUNTER=$((ATTACH_COUNTER + 1))
  plist="${WORK_DIR}/attach-${ATTACH_COUNTER}.plist"
  before_info_plist="${WORK_DIR}/attach-${ATTACH_COUNTER}-before-info.plist"
  after_info_plist="${WORK_DIR}/attach-${ATTACH_COUNTER}-after-info.plist"

  if ! run_hdiutil info -plist >"${before_info_plist}" || ! parse_plist_devices "${before_info_plist}" "${dmg}"; then
    fail \
      "无法读取挂载前的磁盘设备状态。" \
      "Could not read the pre-attach disk device state."
    return 1
  fi
  before_devices=("${PARSED_PLIST_DEVICES[@]}")

  if ! run_hdiutil attach -readonly -nobrowse -noautoopen -plist "${dmg}" >"${plist}" <<<"Y"; then
    fail \
      "无法只读挂载磁盘映像。" \
      "Could not attach the disk image read-only."
    return 1
  fi

  normalize_attach_plist_output "${plist}" || :

  if parse_attach_plist "${plist}" && (( ${#PARSED_PLIST_DEVICES[@]} > 0 )); then
    primary_parse_ok=1
    attached_devices=("${PARSED_PLIST_DEVICES[@]}")
    mount_points=("${PARSED_ATTACH_MOUNT_POINTS[@]}")
    mount_devices=("${PARSED_ATTACH_MOUNT_DEVICES[@]}")
  else
    if ! run_hdiutil info -plist >"${after_info_plist}" || ! parse_plist_devices "${after_info_plist}" "${dmg}"; then
      fail \
        "挂载已成功，但无法读取挂载后的磁盘设备状态。" \
        "The attach succeeded, but the post-attach disk device state could not be read."
      return 1
    fi
    attached_devices=("${PARSED_PLIST_DEVICES[@]}")
    mount_points=("${PARSED_ATTACH_MOUNT_POINTS[@]}")
    mount_devices=("${PARSED_ATTACH_MOUNT_DEVICES[@]}")
  fi

  new_devices=()
  for device in "${attached_devices[@]}"; do
    if ! array_contains "${device}" "${before_devices[@]}" &&
      ! array_contains "${device}" "${new_devices[@]}"; then
      new_devices+=("${device}")
    fi
  done
  if (( ${#mount_points[@]} == 1 && ${#mount_devices[@]} == 1 )); then
    mount_device="${mount_devices[1]}"
    if array_contains "${mount_device}" "${new_devices[@]}"; then
      mount_device_is_new=1
      cleanup_device="${mount_device}"
    fi
  fi
  if [[ -z "${cleanup_device}" ]] && (( ${#new_devices[@]} > 0 )); then
    cleanup_device="${new_devices[1]}"
  fi
  if [[ -n "${cleanup_device}" ]]; then
    MOUNTED_DEVICES+=("${cleanup_device}")
  fi
  if (( primary_parse_ok == 1 && mount_device_is_new == 1 )); then
    ATTACHED_MOUNT_POINT="${mount_points[1]}"
    return 0
  fi
  if (( ${#new_devices[@]} != 1 )); then
    fail \
      "磁盘映像必须且只能产生一个新的根设备。" \
      "The disk image must produce exactly one new root device."
    return 1
  fi
  if (( primary_parse_ok == 0 )); then
    fail \
      "磁盘映像已挂载，但 attach 输出无法解析；已登记新增设备用于清理。" \
      "The disk image attached, but the attach output could not be parsed; new devices were registered for cleanup."
    return 1
  fi
  if (( ${#mount_points[@]} != 1 )); then
    fail \
      "磁盘映像必须且只能产生一个挂载点。" \
      "The disk image must produce exactly one mount point."
    return 1
  fi
  fail \
    "挂载点必须属于本次磁盘映像新产生的设备。" \
    "The mount point must belong to a newly attached disk device."
  return 1
}

build_frame_only_transaction_shell() {
  /bin/cat <<'SH'
set -eu
frameSource=$1
frameTarget=$2
frameParent="$("/usr/bin/dirname" "$frameTarget")"
frameName=${frameTarget##*/}
stageRoot=
backupRoot=
frameStage=
frameBackup=
remove_path_if_exists() {
  path=$1
  if [ -e "$path" ] || [ -L "$path" ]; then
    /bin/rm -rf "$path"
  fi
}
rollback_path() {
  target=$1
  stage=$2
  backup=$3
  if [ -e "$backup" ] || [ -L "$backup" ]; then
    remove_path_if_exists "$target"
    /bin/mv "$backup" "$target"
  elif [ ! -e "$stage" ] && [ ! -L "$stage" ] && { [ -e "$target" ] || [ -L "$target" ]; }; then
    remove_path_if_exists "$target"
  fi
}
cleanup_transaction_dirs() {
  if [ -n "$stageRoot" ]; then
    /bin/rm -rf "$stageRoot"
  fi
  if [ -n "$backupRoot" ]; then
    /bin/rm -rf "$backupRoot"
  fi
}
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  rollback_path "$frameTarget" "$frameStage" "$frameBackup"
  cleanup_transaction_dirs
  exit "$status"
}
trap rollback EXIT HUP INT TERM
stageRoot="$("/usr/bin/mktemp" -d "${frameParent}/.FrameCullAIPro-install.XXXXXXXX")"
backupRoot="$("/usr/bin/mktemp" -d "${frameParent}/.FrameCullAIPro-backup.XXXXXXXX")"
frameStage="${stageRoot}/${frameName}"
frameBackup="${backupRoot}/${frameName}"
/usr/bin/ditto "$frameSource" "$frameStage"
if /usr/bin/xattr -p com.apple.quarantine "$frameStage" >/dev/null 2>&1; then
  /usr/bin/xattr -dr com.apple.quarantine "$frameStage"
fi
if [ -e "$frameTarget" ] || [ -L "$frameTarget" ]; then
  /bin/mv "$frameTarget" "$frameBackup"
fi
/bin/mv "$frameStage" "$frameTarget"
trap - EXIT HUP INT TERM
cleanup_transaction_dirs
SH
}

build_frame_and_raw_transaction_shell() {
  /bin/cat <<'SH'
set -eu
frameSource=$1
frameTarget=$2
rawSource=$3
rawTarget=$4
frameParent="$("/usr/bin/dirname" "$frameTarget")"
rawParent="$("/usr/bin/dirname" "$rawTarget")"
[ "$frameParent" = "$rawParent" ]
frameName=${frameTarget##*/}
rawName=${rawTarget##*/}
stageRoot=
backupRoot=
frameStage=
rawStage=
frameBackup=
rawBackup=
remove_path_if_exists() {
  path=$1
  if [ -e "$path" ] || [ -L "$path" ]; then
    /bin/rm -rf "$path"
  fi
}
rollback_path() {
  target=$1
  stage=$2
  backup=$3
  if [ -e "$backup" ] || [ -L "$backup" ]; then
    remove_path_if_exists "$target"
    /bin/mv "$backup" "$target"
  elif [ ! -e "$stage" ] && [ ! -L "$stage" ] && { [ -e "$target" ] || [ -L "$target" ]; }; then
    remove_path_if_exists "$target"
  fi
}
cleanup_transaction_dirs() {
  if [ -n "$stageRoot" ]; then
    /bin/rm -rf "$stageRoot"
  fi
  if [ -n "$backupRoot" ]; then
    /bin/rm -rf "$backupRoot"
  fi
}
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  rollback_path "$rawTarget" "$rawStage" "$rawBackup"
  rollback_path "$frameTarget" "$frameStage" "$frameBackup"
  cleanup_transaction_dirs
  exit "$status"
}
trap rollback EXIT HUP INT TERM
stageRoot="$("/usr/bin/mktemp" -d "${frameParent}/.FrameCullAIPro-install.XXXXXXXX")"
backupRoot="$("/usr/bin/mktemp" -d "${frameParent}/.FrameCullAIPro-backup.XXXXXXXX")"
frameStage="${stageRoot}/${frameName}"
rawStage="${stageRoot}/${rawName}"
frameBackup="${backupRoot}/${frameName}"
rawBackup="${backupRoot}/${rawName}"
/usr/bin/ditto "$frameSource" "$frameStage"
if /usr/bin/xattr -p com.apple.quarantine "$frameStage" >/dev/null 2>&1; then
  /usr/bin/xattr -dr com.apple.quarantine "$frameStage"
fi
/usr/bin/ditto "$rawSource" "$rawStage"
if /usr/bin/xattr -p com.apple.quarantine "$rawStage" >/dev/null 2>&1; then
  /usr/bin/xattr -dr com.apple.quarantine "$rawStage"
fi
if [ -e "$frameTarget" ] || [ -L "$frameTarget" ]; then
  /bin/mv "$frameTarget" "$frameBackup"
fi
if [ -e "$rawTarget" ] || [ -L "$rawTarget" ]; then
  /bin/mv "$rawTarget" "$rawBackup"
fi
/bin/mv "$frameStage" "$frameTarget"
/bin/mv "$rawStage" "$rawTarget"
trap - EXIT HUP INT TERM
cleanup_transaction_dirs
SH
}

install_frame_only_privileged() {
  local frame_source_app="$1"
  local transaction_shell
  local sanitized_transaction_shell

  transaction_shell="$(build_frame_only_transaction_shell)"
  sanitized_transaction_shell=$'unset BASH_ENV ENV CDPATH IFS\nPATH=\nexport PATH\n'"${transaction_shell}"

  if ! /usr/bin/osascript - "${frame_source_app}" "${sanitized_transaction_shell}" <<'APPLESCRIPT'
on run argv
  if (count of argv) is not 2 then error "Expected one FrameCull source app and one transaction shell"
  set frameSource to item 1 of argv
  set transactionShell to item 2 of argv
  set frameTarget to "/Applications/FrameCull AI Pro.app"
  set commandText to "/usr/bin/env -i /bin/sh -c " & quoted form of transactionShell & " sh " & quoted form of frameSource & " " & quoted form of frameTarget
  do shell script commandText with administrator privileges
end run
APPLESCRIPT
  then
    fail \
      "管理员授权已取消或 FrameCull 安装失败。" \
      "Administrator authorization was cancelled or FrameCull installation failed."
  fi
}

install_frame_and_raw_privileged() {
  local frame_source_app="$1"
  local raw_source_app="$2"
  local transaction_shell
  local sanitized_transaction_shell

  transaction_shell="$(build_frame_and_raw_transaction_shell)"
  sanitized_transaction_shell=$'unset BASH_ENV ENV CDPATH IFS\nPATH=\nexport PATH\n'"${transaction_shell}"

  if ! /usr/bin/osascript - "${frame_source_app}" "${raw_source_app}" "${sanitized_transaction_shell}" <<'APPLESCRIPT'
on run argv
  if (count of argv) is not 3 then error "Expected FrameCull source, RawTherapee source, and transaction shell"
  set frameSource to item 1 of argv
  set rawSource to item 2 of argv
  set transactionShell to item 3 of argv
  set frameTarget to "/Applications/FrameCull AI Pro.app"
  set rawTarget to "/Applications/RawTherapee.app"
  set commandText to "/usr/bin/env -i /bin/sh -c " & quoted form of transactionShell & " sh " & quoted form of frameSource & " " & quoted form of frameTarget & " " & quoted form of rawSource & " " & quoted form of rawTarget
  do shell script commandText with administrator privileges
end run
APPLESCRIPT
  then
    fail \
      "管理员授权已取消或应用安装失败。" \
      "Administrator authorization was cancelled or app installation failed."
  fi
}

install_cli_for_user() {
  local source_cli="$1"
  local cli_dir

  [[ -f "${source_cli}" ]] || fail \
    "找不到 RawTherapee CLI 来源文件。" \
    "RawTherapee CLI source file is missing."
  cli_dir="$(/usr/bin/dirname "${MANAGED_CLI}")"
  /bin/mkdir -p "${cli_dir}"
  CLI_TEMP_PATH="$(/usr/bin/mktemp "${cli_dir}/.rawtherapee-cli.XXXXXX")"
  /usr/bin/ditto "${source_cli}" "${CLI_TEMP_PATH}"
  /bin/chmod 755 "${CLI_TEMP_PATH}"
  if /usr/bin/xattr -p com.apple.quarantine "${CLI_TEMP_PATH}" >/dev/null 2>&1; then
    /usr/bin/xattr -d com.apple.quarantine "${CLI_TEMP_PATH}"
  fi
  /bin/mv -f "${CLI_TEMP_PATH}" "${MANAGED_CLI}"
  CLI_TEMP_PATH=""
}

install_frame_only() {
  local frame_mount frame_source_app

  print -r -- "RawTherapee 健康：只更新 FrameCull AI Pro。"
  print -r -- "RawTherapee is healthy: updating FrameCull AI Pro only."
  attach_dmg_readonly "${FRAME_DMG}"
  frame_mount="${ATTACHED_MOUNT_POINT}"
  frame_source_app="${frame_mount}/FrameCull AI Pro.app"
  [[ -d "${frame_source_app}" ]] || fail \
    "FrameCull DMG 中缺少 FrameCull AI Pro.app。" \
    "FrameCull AI Pro.app is missing from the FrameCull DMG."

  install_frame_only_privileged "${frame_source_app}"
  if ! verify_frame_signature "${FRAME_APP}"; then
    fail \
      "FrameCull AI Pro 签名验证失败。" \
      "FrameCull AI Pro code-signature verification failed."
  fi
}

repair_rawtherapee_and_install_frame() {
  local frame_mount raw_mount frame_source_app raw_source_app
  local cli_status=0

  print -r -- "RawTherapee 缺失或损坏：修复 RawTherapee 并更新 FrameCull AI Pro。"
  print -r -- "RawTherapee is missing or unhealthy: repairing it and updating FrameCull AI Pro."
  extract_rawtherapee_payload

  attach_dmg_readonly "${FRAME_DMG}"
  frame_mount="${ATTACHED_MOUNT_POINT}"
  frame_source_app="${frame_mount}/FrameCull AI Pro.app"
  [[ -d "${frame_source_app}" ]] || fail \
    "FrameCull DMG 中缺少 FrameCull AI Pro.app。" \
    "FrameCull AI Pro.app is missing from the FrameCull DMG."

  attach_dmg_readonly "${RAW_PAYLOAD_DMG}"
  raw_mount="${ATTACHED_MOUNT_POINT}"
  raw_source_app="${raw_mount}/RawTherapee.app"
  [[ -d "${raw_source_app}" ]] || fail \
    "RawTherapee DMG 中缺少 RawTherapee.app。" \
    "RawTherapee.app is missing from the RawTherapee DMG."

  install_frame_and_raw_privileged "${frame_source_app}" "${raw_source_app}"
  [[ -d "${FRAME_APP}" && -d "${RAW_APP}" ]] || fail \
    "应用复制后未出现在固定目标路径。" \
    "Installed apps are missing from their fixed destination paths."
  install_cli_for_user "${RAW_PAYLOAD_CLI}"
  [[ -x "${MANAGED_CLI}" ]] || fail \
    "用户 RawTherapee CLI 安装失败。" \
    "Managed RawTherapee CLI installation failed."

  if run_cli_version_with_timeout "${MANAGED_CLI}" 10; then
    cli_status=0
  else
    cli_status=$?
  fi
  if ! rawtherapee_version_probe_is_healthy "${cli_status}" "${CLI_VERSION_OUTPUT}"; then
    print -u2 -r -- "RawTherapee CLI exit status: ${cli_status}"
    [[ -z "${CLI_VERSION_OUTPUT}" ]] || print -u2 -r -- "${CLI_VERSION_OUTPUT}"
    fail \
      "安装后的 RawTherapee CLI 验证失败。" \
      "Installed RawTherapee CLI verification failed."
  fi
  if ! verify_frame_signature "${FRAME_APP}"; then
    fail \
      "FrameCull AI Pro 签名验证失败。" \
      "FrameCull AI Pro code-signature verification failed."
  fi
}

run_install_for_mode() {
  local mode="$1"
  case "${mode}" in
    "${MODE_UPDATE}")
      install_frame_only
      ;;
    "${MODE_REPAIR}")
      repair_rawtherapee_and_install_frame
      ;;
    *)
      fail \
        "未知安装模式：${mode}" \
        "Unknown installer mode: ${mode}"
      ;;
  esac
}

main() {
  local mode temp_root

  if [[ "${1:-}" == "--verify-only" ]]; then
    ACTIVE_MODE="${MODE_VERIFY_ONLY}"
  else
    ACTIVE_MODE=""
  fi
  trap 'handle_failure $?' ZERR
  trap cleanup EXIT

  (( $# <= 1 )) || fail \
    "参数过多。仅支持 --verify-only。" \
    "Too many arguments. Only --verify-only is supported."
  case "${1:-}" in
    "")
      ;;
    --verify-only)
      ;;
    *)
      fail \
        "未知参数：$1" \
        "Unknown argument: $1"
      ;;
  esac

  print -r -- "FrameCull AI Pro macOS 统一安装与更新"
  print -r -- "FrameCull AI Pro unified macOS install and update"
  verify_package_contract
  temp_root="${TMPDIR:-/tmp}"
  WORK_DIR="$(/usr/bin/mktemp -d "${temp_root}/framecull-pro-installer.XXXXXX")"

  if [[ "${ACTIVE_MODE}" == "${MODE_VERIFY_ONLY}" ]]; then
    extract_rawtherapee_payload
    if ! cleanup; then
      fail \
        "安装包已验证，但临时资源清理失败。" \
        "Package verification completed, but temporary resource cleanup failed."
    fi
    trap - ZERR
    trap - EXIT
    print -r -- "安装包校验与 RawTherapee 结构检查通过。"
    print -r -- "Package checks and RawTherapee payload verification passed."
    return 0
  fi

  determine_install_mode \
    "${RAW_APP}" \
    "${MANAGED_CLI}" \
    "/usr/local/bin/rawtherapee-cli" \
    "/opt/homebrew/bin/rawtherapee-cli" >/dev/null
  mode="${INSTALL_MODE}"
  ACTIVE_MODE="${mode}"
  print -r -- "安装模式：${mode}"
  print -r -- "Installer mode: ${mode}"
  run_install_for_mode "${mode}"

  if ! cleanup; then
    fail \
      "安装已完成，但挂载或临时资源清理失败，因此不会启动 FrameCull AI Pro。" \
      "Installation completed, but mounted or temporary resource cleanup failed, so FrameCull AI Pro will not be opened."
  fi
  trap - ZERR
  trap - EXIT
  if ! open_frame_app "${FRAME_APP}"; then
    print -u2 -r -- "FrameCull AI Pro 已安装，但启动失败。"
    print -u2 -r -- "FrameCull AI Pro was installed, but could not be opened."
    pause_if_interactive
    return 1
  fi
  print -r -- "安装与验证完成，FrameCull AI Pro 已启动。"
  print -r -- "Installation and verification completed; FrameCull AI Pro was opened."
  pause_if_interactive
}

if [[ "${FRAMECULL_INSTALLER_SOURCE_ONLY:-0}" != "1" ]]; then main "$@"; fi
