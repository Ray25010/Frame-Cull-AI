FrameCull AI Pro macOS 内部测试版
=================================

本测试包尚未经过 Apple Developer ID 公证，仅提供给受信任测试人员。请只运行来自 FrameCull AI 官方测试渠道的完整 ZIP。

推荐流程
--------
1. 下载与 Mac 架构对应的 FrameCull Pro ZIP，并完整解压。
2. 打开其中的 FrameCull AI Pro DMG，将应用拖入“应用程序”。
3. 启动 FrameCull AI Pro。RawTherapee 5.12 已随应用内置，无需另行安装、复制 CLI 或授权。

FrameCull AI Pro 会优先使用应用包内的 RawTherapee CLI；如果内置引擎无法启动，软件会报告错误并使用已有的 RAW 预览回退逻辑。不会要求用户安装 RawTherapee 或执行额外授权。

如果 Finder 拦截脚本
---------------------
1. 打开“终端”。
2. 输入字面量 "/bin/zsh "（不要输入双引号，并保留末尾空格）。
3. 把“FrameCull-Pro-Install.command”从 Finder 拖入终端窗口。
4. 按回车。脚本的校验、状态判断和管理员授权流程与右键打开时相同。

安装位置
--------
- FrameCull AI Pro：/Applications/FrameCull AI Pro.app
- RawTherapee：位于 FrameCull AI Pro.app/Contents/Resources/raw-engines/rawtherapee/，不单独出现在“应用程序”中

安全边界
--------
- 发布构建会核对官方 RawTherapee 归档的固定 SHA-256，并检查内置 app、CLI 与动态库结构。
- 脚本不会关闭全局 Gatekeeper，也不会修改其他应用。
- FrameCull AI Pro 当前仍使用 ad-hoc 签名且未公证；正式公开版本仍需要 Apple Developer ID 签名和公证。

故障排查
--------
如果内置 RawTherapee CLI 无法启动，请保留错误信息并联系测试包提供者。不要从非官方来源替换应用包内文件。
