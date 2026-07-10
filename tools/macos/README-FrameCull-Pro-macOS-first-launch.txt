FrameCull AI Pro macOS 内部测试版
=================================

本测试包尚未经过 Apple Developer ID 公证，仅提供给受信任测试人员。请只运行来自 FrameCull AI 官方测试渠道的完整 ZIP。

推荐流程（首次安装和后续更新使用同一个脚本）
------------------------------------------------
1. 下载与 Mac 架构对应的 FrameCull Pro ZIP，并完整解压。
2. 在解压后的文件夹中，右键点击唯一脚本“FrameCull-Pro-Install.command”。
3. 选择“打开”，等待脚本先校验包内容，再完成安装或更新。
4. macOS 必要时会显示一次原生管理员密码窗口；确认后继续等待验证完成。

脚本会自动选择安全路径：
- 首次安装，或 RawTherapee app / CLI 缺失、损坏、不可执行、版本验证失败时，会修复并安装 FrameCull AI Pro、RawTherapee 和独立 CLI。
- RawTherapee 健康时，后续更新只更新 FrameCull AI Pro；脚本只更新 FrameCull，不会重新解压、挂载、替换或修改 RawTherapee 和 CLI。
- 任何校验、挂载、授权、CLI 验证或签名验证失败时，脚本会停止且不会启动 FrameCull AI Pro。

如果 Finder 拦截脚本
---------------------
1. 打开“终端”。
2. 输入字面量 "/bin/zsh "（不要输入双引号，并保留末尾空格）。
3. 把“FrameCull-Pro-Install.command”从 Finder 拖入终端窗口。
4. 按回车。脚本的校验、状态判断和管理员授权流程与右键打开时相同。

安装位置
--------
- FrameCull AI Pro：/Applications/FrameCull AI Pro.app
- RawTherapee：/Applications/RawTherapee.app
- FrameCull 管理的 RawTherapee CLI：
  ~/Library/Application Support/com.framecull.ai.pro/tools/rawtherapee-cli

安全边界
--------
- 脚本先验证 SHA256SUMS.txt，并再次核对官方 RawTherapee ZIP 的固定 SHA-256。
- 所有 DMG 都以只读、无 Finder 弹窗方式挂载。
- 管理员授权只精确替换固定名称的 app；健康更新路径不会触碰 RawTherapee。
- 隔离标记只在新安装的 FrameCull、修复路径中的 RawTherapee，以及新复制的独立 CLI 上处理。
- 脚本不会关闭全局 Gatekeeper，也不会修改其他应用。
- FrameCull AI Pro 当前仍使用 ad-hoc 签名且未公证；正式公开版本仍需要 Apple Developer ID 签名和公证。

手动故障回退（仅在统一脚本失败时）
----------------------------------
1. 先保存脚本窗口中的错误信息，并联系测试包提供者确认包未损坏。
2. 可手动打开 FrameCull DMG，把“FrameCull AI Pro.app”拖入 /Applications。
3. 如需修复 RawTherapee，再解压“RawTherapee_macOS_15.4_Universal_5.12.zip”，打开其中固定名称的 DMG，把“RawTherapee.app”拖入 /Applications。
4. 将同一官方归档中的“rawtherapee-cli”复制到上面的用户 CLI 路径并确保其可执行。
5. 手动流程仅作为故障回退；正常首次安装和后续更新都应使用“FrameCull-Pro-Install.command”。
