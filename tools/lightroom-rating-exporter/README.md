# FrameCull Lightroom 星级回收工具

这个小工具给打星的朋友使用。它只读取 Lightroom Classic 的 `.lrcat` 目录库，生成一个可以发回来的星级文件包，不会修改照片，也不会修改 Lightroom catalog。

## Mac 使用（推荐）

1. 退出 Lightroom Classic。
2. 双击 `run-mac.command`。
3. 系统会弹出选择输出文件夹的窗口，选桌面即可。
4. 如果知道照片文件夹，可以在下一步选择；不知道就点 `Skip`。
5. 等 Terminal 显示 `Done`。
6. 把生成的 `framecull-lr-ratings-*.zip` 发回来。

`run-mac.command` 不使用 Python 图形界面，所以如果 Tkinter 在某些 Mac 上白屏，也不影响使用。

## Mac 图形界面备用

`run-mac-gui.command` 是 Python/Tkinter 图形界面版。如果窗口白屏，请关闭它，改用 `run-mac.command`。

如果 Mac 提示不能运行，可以打开 Terminal 后执行：

```bash
chmod +x run-mac.command
./run-mac.command
```

## Windows 使用

双击 `run-windows.bat`，其他步骤相同。

## 命令行兜底

```bash
python3 lightroom_rating_exporter.py --output ~/Desktop
```

如果知道照片所在文件夹，可以加：

```bash
python3 lightroom_rating_exporter.py --output ~/Desktop --photo-dir "/Volumes/照片盘/相机"
```

## 输出内容

生成的 zip 里包含：

- `labels-from-lrcat.json`：FrameCull 训练/评估可用的标签文件
- `ratings.csv`：人工可读的文件名、路径、星级表
- `catalog-report.json`：扫描到的 catalog 和星级分布
- `collision-report.csv`：同名文件冲突时才有内容
