<p align="center">
  <img src="public/icon.png" width="112" alt="Readly">
</p>

<h1 align="center">Readly</h1>

<p align="center">一个安静的轻量电子书阅读器 · Windows / Android · EPUB / TXT · WebDAV 多端同步</p>

<p align="center">
  <a href="https://github.com/Wlaina/readly-releases/releases/latest">下载安装包</a> ·
  <a href="#开发">从源码构建</a> ·
  <a href="LICENSE">AGPL-3.0</a>
</p>

---

Readly 只做三件事：**好好读书、好看、在手机和电脑之间无缝接着读**。
界面是“暖纸 · 液态玻璃”风格：羊皮纸底色、赤陶色点缀、浮在流动色光上的毛玻璃。

## 功能

- **格式**：EPUB、TXT（自动识别 UTF-8 / UTF-16 / GBK 编码，自动切分章节）
- **阅读**：左右翻页或上下滚动，点击 / 滚轮 / 音量键翻页；目录支持分卷折叠；书签、高亮、笔记；书内模糊搜索
- **外观**：11 种阅读背景 + 自定义颜色，字号、行距、段距、缩进、边距、宽屏双栏，可导入自己的字体；阅读时可单独调亮度
- **书架**：多列 / 单本 3D 轮播，分类，多种排序，模糊搜索（支持拼音首字母）
- **同步**：WebDAV（坚果云、Koofr、Nextcloud 等）——同步进度、书签、笔记、阅读时长、分类、书籍文件和设置
- **动画**：多种动画风格与速度；打开书时可选“翻开封面”“文字浮现”“符文飞入”
- **其他**：阅读统计、自动更新、中文 / English 界面、诊断日志导出

## 下载

安装包发布在 [Wlaina/readly-releases](https://github.com/Wlaina/readly-releases/releases/latest)：

- Windows：`Readly_x.y.z_x64-setup.exe`（安装版，自动更新）
- Android：`Readly-arm64.apk`（arm64）

## 开发

需要 Node.js 20+、Rust（stable）；打包安卓还需要 Android SDK / NDK 与 JDK 17。

```bash
npm install
npm run dev          # 浏览器预览 http://localhost:1420（数据存在 IndexedDB）
npm run app:dev      # 桌面应用调试
npx tauri build --bundles nsis   # Windows 安装包
```

安卓打包见 `scripts/build-android.ps1`（Windows 上未开启开发者模式时用复制 .so 的方式绕过符号链接）。

### 目录

```
src/
  components/      书架、阅读器、设置、同步等界面
  lib/
    store.ts       全局状态与持久化（zustand）
    sync.ts        WebDAV 同步引擎与合并规则
    book.ts / txt.ts  EPUB 解析、TXT 转换
    settings.ts    外观与行为设置、注入书页的 CSS
    textfx.ts      打开书时的文字特效（画布绘制）
    bookfx.ts      翻开封面动画
  vendor/foliate-js  渲染引擎（Readest 维护的分支，MIT）
src-tauri/         Rust 端与安卓工程（gen/android）
app-icon/          图标源文件（SVG）
```

### 云端目录约定（默认 `/Readly`）

| 路径 | 说明 |
| --- | --- |
| `/Readly/*.epub`、`/Readly/*.txt` | 手动放进来的书，同步时自动导入，原文件不动 |
| `/Readly/devices/<设备ID>.json.gz` | 每台设备一个文件：进度、书签、笔记、阅读时长、分类 |
| `/Readly/files/<hash>.<ext>` | Readly 上传的书籍文件 |
| `/Readly/settings-desktop.json` / `settings-mobile.json` | 外观与行为设置，电脑与手机分开 |

## 致谢

- [Readest](https://github.com/readest/readest)（AGPL-3.0）：Readly 的思路与图标轮廓都来自它；Readly 的图标是在 Readest 图标的基础上重画并改了配色。
- [foliate-js](https://github.com/johnfactotum/foliate-js)（MIT）：EPUB 渲染引擎，使用的是 Readest 维护的分支。
- [Tauri](https://tauri.app/)、[React](https://react.dev/)、[zustand](https://github.com/pmndrs/zustand)。

## 许可证

[GNU AGPL-3.0](LICENSE)。`src/vendor/foliate-js` 保留其原有的 MIT 许可证。
