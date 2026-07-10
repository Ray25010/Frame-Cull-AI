FrameCull AI Pro macOS 内部测试版
=================================

本测试包尚未经过 Apple Developer ID 公证，仅用于受信任测试者。
请只运行来自 FrameCull AI 官方测试渠道的文件。

正常安装：
1. 根据 Mac 芯片下载对应版本：
   - Apple Silicon（M1/M2/M3/M4 等）：FrameCull-Pro-macOS-arm64.zip
   - Intel Mac：FrameCull-Pro-macOS-x64.zip
2. 解压 ZIP 并打开其中的 DMG。
3. 把“FrameCull AI Pro”拖入 Applications（应用程序）。
4. 尝试从 Applications 打开应用。

如果 macOS 提示无法验证开发者：
1. 右键点击“FrameCull-Pro-First-Launch.command”。
2. 选择“打开”，确认只运行这一次。
3. 脚本只会对以下应用移除下载隔离标记，然后打开它：
   /Applications/FrameCull AI Pro.app

RAW 全尺寸渲染（安装随包附带的 RawTherapee）：
- Pro ZIP 已附带“RawTherapee_macOS_15.4_Universal_5.12.zip”，不需要额外下载。
- 同一个 Universal 安装包同时支持 Apple Silicon 和 Intel Mac。
1. 解压“RawTherapee_macOS_15.4_Universal_5.12.zip”。
2. 把“RawTherapee.app”拖入 /Applications（应用程序）。
3. 首次打开若被 macOS 拦截，请右键“RawTherapee.app”并选择“打开”。
4. FrameCull AI Pro 会自动探测：
   /Applications/RawTherapee.app/Contents/MacOS/rawtherapee-cli
- NEF 等 RAW 的内嵌预览和其他不依赖 RawTherapee 的功能仍可正常尝试。

安全边界：
- FrameCull AI Pro 测试应用继续使用现有 ad-hoc 签名。
- “FrameCull-Pro-First-Launch.command”只处理 FrameCull AI Pro，不处理 RawTherapee 或其他应用。
- 脚本不使用 sudo，也不需要管理员密码。
- 脚本不会关闭全局 Gatekeeper。
- 脚本不会修改其他应用。
- 正式公开版本仍需要 Apple Developer ID 签名和公证。
