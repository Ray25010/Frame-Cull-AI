# FrameCull AI Pro macOS 统一安装器修正设计

## 背景与已验证事实

Actions run `29107235393` 已成功生成 arm64 和 x64 Pro 测试包，但实包检查发现旧设计对官方 RawTherapee 归档结构的假设错误，当前 Draft 不应发给测试用户。

官方 `RawTherapee_macOS_15.4_Universal_5.12.zip` 的固定 SHA-256 为：

```text
2f284d1c023f53f0c492aecc3f7635d6b7807ef22d5413ee55715d81e81fe688
```

归档内实际包含：

```text
RawTherapee_macOS_15.4_Universal_5.12_folder/
  RawTherapee_macOS_15.4_Universal_5.12.dmg
  rawtherapee-cli
  install-readme.txt
```

官方说明要求先把 DMG 中的 `RawTherapee.app` 安装到 `/Applications`；独立 `rawtherapee-cli` 会从该 app 动态加载运行库。CLI 不位于 `RawTherapee.app/Contents/MacOS/`，因此旧 README 和旧 macOS 自动探测路径均不成立。

## 目标

把测试用户的操作压缩为：

1. 解压与 Mac 架构对应的 FrameCull Pro ZIP。
2. 右键打开一个统一安装脚本。
3. macOS 要求时确认一次标准管理员密码窗口。
4. 等待脚本安装、验证并启动 FrameCull AI Pro。

用户不需要手动打开 DMG、拖动 app、复制 CLI、输入终端命令或配置路径。

## 不采用直接嵌入

不把 RawTherapee CLI、app 或运行库嵌入 `FrameCull AI Pro.app`，原因如下：

- 在 FrameCull 完成签名后修改 app 内容会使签名失效，可能导致 macOS 拒绝启动。
- 只嵌入 CLI 不能消除 RawTherapee app 安装要求，因为 CLI 仍从 `/Applications/RawTherapee.app` 动态加载库。
- 嵌入完整 RawTherapee 运行时会引入嵌套签名、路径、体积和更新边界，超出当前测试包目标。

官方 RawTherapee ZIP 在外层 Pro ZIP 中继续保持字节不变，由固定 SHA 和包内 `SHA256SUMS.txt` 双重覆盖。

## 统一安装脚本

用 `FrameCull-Pro-Install.command` 替换现有仅处理 FrameCull 隔离标记的首启 helper。脚本使用系统自带 `/bin/zsh`，执行以下步骤：

1. 切换到脚本所在目录并定位唯一的 FrameCull Pro DMG、官方 RawTherapee ZIP、README 和 `SHA256SUMS.txt`。
2. 使用 `/usr/bin/shasum -a 256 --check` 验证外层包内全部 payload，并再次强制核对 RawTherapee 固定 SHA。
3. 在 `mktemp` 临时目录中用 `/usr/bin/ditto -x -k` 解压官方 ZIP，要求 DMG、CLI 和官方说明三个固定文件均存在。
4. 以只读、非 Finder 弹窗方式挂载两个 DMG，并通过 `hdiutil -plist` 与系统 plist 工具读取实际挂载点。
5. 通过一个 macOS 标准管理员授权窗口，把两个已构建 app 精确复制到：
   - `/Applications/FrameCull AI Pro.app`
   - `/Applications/RawTherapee.app`
6. 把官方独立 CLI 复制到当前用户目录：
   - `~/Library/Application Support/com.framecull.ai.pro/tools/rawtherapee-cli`
7. 只对上述两个 app 和 CLI 移除下载隔离标记；不关闭全局 Gatekeeper，不执行 `spctl --master-disable`，不修改其他应用。
8. 验证 FrameCull app 签名、两个 app 的存在性和 CLI 的 `-v` 输出，成功后启动 FrameCull AI Pro。
9. 无论成功或失败，都卸载临时 DMG、删除临时目录，并显示中英双语结果。

脚本不得使用 `eval`，管理员命令只能操作固定目标路径。动态来源路径必须经过 AppleScript `quoted form` 或等价的安全参数传递，不能拼接未经转义的 shell 输入。

## 权限与首次打开

- 脚本不使用 `sudo`；需要写入 `/Applications` 时，通过 `osascript ... with administrator privileges` 显示 macOS 原生授权窗口。
- 用户已接受可能出现一次管理员密码窗口。
- 当前 FrameCull 仍是 ad-hoc 签名且未公证，因此没有 Developer ID 时，首次右键“打开”统一安装脚本仍是不可消除的最小 Gatekeeper 步骤。
- 脚本复制已签名的 FrameCull app，不修改其 bundle 内容；复制和移除 quarantine 不应改变代码签名。

## FrameCull CLI 自动探测

后端增加 macOS 固定候选路径：

```text
~/Library/Application Support/com.framecull.ai.pro/tools/rawtherapee-cli
/usr/local/bin/rawtherapee-cli
/opt/homebrew/bin/rawtherapee-cli
```

移除不符合 RawTherapee 5.12 官方包结构的 app 内 CLI 假设。统一安装器使用第一条用户目录路径，不需要额外配置 PATH 或管理员权限。

候选路径生成逻辑应拆成可在 Windows 开发机上运行的纯函数测试，确保 macOS 目标路径不会再次依赖未验证假设。

## CI 与打包

`.github/workflows/macos-pro-test-build.yml` 继续下载并验证官方 RawTherapee ZIP，同时增加：

- `/bin/zsh -n` 检查统一安装脚本语法。
- 检查官方 ZIP 内固定 DMG、CLI 和说明文件的实际结构。
- 将统一脚本替换旧 helper 放入 arm64/x64 外层 ZIP，并保留可执行权限。
- `SHA256SUMS.txt` 覆盖 FrameCull DMG、官方 RawTherapee ZIP、统一脚本和中文 README。
- 在 staged package 中运行统一脚本的 `--verify-only` 模式，只验证校验和与 RawTherapee 归档结构，不挂载、不安装、不请求管理员权限。
- Draft Release notes 明确“一次脚本安装”、ad-hoc 未公证状态和官方 RawTherapee ZIP 保持原样。

Flash 构建、Windows Pro 内置 RawTherapee 和现有 x64 ONNX Runtime 1.23.2 逻辑不变。

## 失败处理

- 任一哈希、归档结构、DMG、app、CLI、签名或挂载步骤失败时立即停止，不启动 FrameCull。
- 管理员授权被取消时，不继续复制或移除隔离标记。
- 若目标 app 已存在，授权窗口中的固定安装命令允许精确替换同名 app；不删除其他路径。
- trap 必须清理已挂载映像和临时目录，避免残留卷或临时文件。
- README 保留手动安装作为故障回退，但主流程只展示统一脚本。

## 验证

本地和 CI 需要覆盖：

- RawTherapee macOS 候选路径测试先失败、实现后通过。
- 统一脚本语法和 `--verify-only` 包契约通过。
- 29 个前端测试文件、220 项既有测试继续通过。
- Pro release 检查和 `cargo check --features pro-bench --bins` 通过。
- macOS arm64/x64 runner 均完成 app 构建、签名校验、统一脚本自检、ZIP staging 和 Draft Release。
- 下载新 Draft Release 两个 ZIP，匹配 GitHub asset digest，并验证全部内部校验和、RawTherapee 固定 SHA、统一脚本可执行位和安全边界。
- 新包必须是 FrameCull AI Pro，不能出现 FrameCull AI Flash 身份。

## 成功标准

测试用户拿到对应架构 ZIP 后，只需解压、右键打开一个统一安装脚本，并在需要时确认一次系统授权。脚本完成两个 app 与 CLI 的安装、验证和启动；FrameCull 自动识别 CLI，用户无需输入任何技术命令。
