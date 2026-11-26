# MeteorAgent 桌面内测版

## Windows

适用于 Windows 10 和 11 x64。运行内测 `Setup.exe` 后，从桌面或开始菜单打开 **MeteorAgent Beta**。安装包自带 Node.js 和 Pi，安装阶段可离线进行。登录、模型请求和在线插件下载需要网络。更新时先退出桌面内测版，再运行新安装程序。[Windows 使用说明](windows/安装说明.md)

## macOS

适用于 Apple Silicon Mac（M 系列芯片，macOS 13.5 或更新版本）。打开 `.dmg`，把带助手徽标的 **MeteorAgent Beta** 拖进「应用程序」，再双击打开。安装包自带 Node.js 和 Pi，启动后用流星 API 账号登录。

内测包使用本地临时签名。收到文件后可用附带的 `SHA256SUMS` 核对完整性。确认来源后，如果 macOS 首次阻止打开，可到「系统设置 → 隐私与安全性」为此 App 选择「仍要打开」。[Apple 的说明](https://support.apple.com/zh-cn/102445)

桌面版会读取同一台电脑上的 MeteorAgent 账号、会话和插件目录。切换时先等旧版任务结束，同一会话请在一个版本里操作。浏览器中的主题、布局和默认权限等偏好可在桌面版中重新选择。

关闭窗口后，Dock 里仍可打开 Magent。按 `⌘Q` 退出会停止桌面 Beta 的本地服务。可在应用菜单中找到启动日志。新版内测包可通过覆盖「应用程序」内的 **MeteorAgent Beta** 更新。

## 构建 macOS 内测包

在装有 Xcode 26 或更新版本的 Apple Silicon Mac 上，从 `pi-web` 根目录执行以下命令。输入目录须包含校验通过的发布清单 `latest.json` 和对应的 `.tgz`。Xcode 用于构建 macOS 26 的原生图标，用户安装时只需满足前文的系统版本要求。

```sh
bash desktop/package-macos.sh ../meteoragent-brand/dist/customer-release.0.1.29
```

构建脚本会锁定并核对 Electron、Node.js 和 MeteorAgent 的 SHA-256，在临时目录安装生产依赖，并生成 `.dmg` 和 `SHA256SUMS`。`METEOR_DESKTOP_DOWNLOAD_DIR` 可指定已有上游压缩包的目录，提供的文件仍须通过校验。运行时保留 Node.js 和 npm。需要从源码编译的第三方插件会通过其构建工具获取所需头文件。

## 构建 Windows x64 内测包

从 `pi-web` 根目录执行以下命令。构建机需要 Node.js、npm、Python 3 和 NSIS 的 `makensis`。`MAKENSIS_BIN` 可指定编译器路径，`METEOR_DESKTOP_DOWNLOAD_DIR` 可复用已校验的上游压缩包。

```sh
bash desktop/package-windows.sh ../meteoragent-brand/dist/customer-release.0.1.29
```

构建脚本安装锁定的 Windows x64 依赖，把桌面图标写入应用和安装程序，并为 `Setup.exe` 生成 SHA-256 校验值。
