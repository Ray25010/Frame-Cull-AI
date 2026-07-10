#!/bin/zsh
set -euo pipefail

readonly APP_PATH="/Applications/FrameCull AI Pro.app"

pause_before_exit() {
  read -r "?按回车键关闭此窗口 / Press Return to close..."
}

echo "FrameCull AI Pro 内部测试版首次打开助手"
echo "This helper only removes quarantine from:"
echo "  ${APP_PATH}"
echo

if [[ ! -d "${APP_PATH}" ]]; then
  echo "未找到应用。请先打开 DMG，并把 FrameCull AI Pro 拖入 Applications。"
  echo "App not found. Drag FrameCull AI Pro from the DMG into Applications first."
  pause_before_exit
  exit 1
fi

/usr/bin/xattr -dr com.apple.quarantine "${APP_PATH}"

if /usr/bin/xattr -p com.apple.quarantine "${APP_PATH}" >/dev/null 2>&1; then
  echo "解除隔离失败，请联系测试包提供者。"
  echo "Quarantine removal failed. Contact the test build provider."
  pause_before_exit
  exit 1
fi

echo "处理完成，正在打开 FrameCull AI Pro。"
echo "Done. Opening FrameCull AI Pro."
/usr/bin/open "${APP_PATH}"
pause_before_exit
