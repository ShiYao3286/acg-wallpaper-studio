<div align="center">

# 🖼 ACG 壁纸工作室

**随机二次元壁纸 + AI 生图壁纸的 Windows 桌面管理工具**

基于 Electron · 深紫玻璃拟态 UI · 系统托盘常驻 · 游戏运行自动暂停

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-blue)](https://github.com/ShiYao3286/acg-wallpaper-studio)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

</div>

## ✨ 功能

| | |
|---|---|
| 🎴 **双壁纸来源** | Lolicon 随机二次元图(Pixiv)· AI 生图(OpenAI 兼容 API) |
| 🎲 **随机灵感模式** | 完全随机 / 锁定人物 / 锁定风景,本地词池自动拼装 Danbooru 提示词 |
| 🔌 **API 服务管理** | 预设多个画图/文本 API,拉取模型列表、连通测试 |
| 🪄 **提示词助手** | 文本模型结合标签池扩写主题;未配置时本地词池兜底 |
| ⏰ **定时换图** | 间隔可调,检测到游戏进程自动暂停 |
| 🖼 **历史与收藏** | 缩略图画廊、收藏夹、一键回设 |
| 📟 **系统托盘** | 后台常驻,右键立即换图 |
| 🔗 **脚本联动** | 兼容传统 PowerShell 计划任务方案(文件监听 + 动作回执) |
| 🌐 **网络代理** | HTTP 代理支持,自动探测本机代理端口 |

## 🚀 快速开始

### 方式一:下载安装包

从 [Releases](../../releases) 下载 `Setup.exe` 安装,或 `免安装.zip` 解压即用。

### 方式二:从源码运行

```bash
git clone https://github.com/ShiYao3286/acg-wallpaper-studio.git
cd acg-wallpaper-studio
npm install --registry=https://registry.npmmirror.com
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm start          # 开发运行
npm run dist       # 打包安装包
```

## ⚙️ 初始配置

软件**不预置任何 API 密钥**,首次使用请:

1. **Lolicon 模式**(开箱即用):无需配置,直接点「立即换一张」
2. **AI 生图模式**:到「API 服务」页 → 添加服务 → 类型选「画图」→ 填入任意 OpenAI 兼容 API(需支持 `/v1/images/generations`)→ 拉取模型 → 测试连通 → 设为画图
3. (可选)提示词助手:添加一个「文本」类型服务(如任意 chat 模型 API)
4. (可选)网络代理:若 Lolicon 在你的网络下直连超时,设置页开启代理并自动探测端口

## 📁 数据位置

| 内容 | 路径 |
|---|---|
| 应用配置 | `%APPDATA%/acg-wallpaper-studio/config.json` |
| 壁纸与历史 | `~/Pictures/ACG_Wallpaper/` |
| 收藏夹 | `~/Pictures/ACG_Wallpaper/favorites/` |

## 🔗 与传统脚本联动

如果你之前用的是「PowerShell 脚本 + 计划任务」方案:脚本换图成功后向壁纸目录写一份 `wallpaper_meta.json`(示例见 [scripts/](scripts/)),软件会实时感知并同步 UI——两种方案可以共存。

## 🛡 隐私与安全

- 所有配置(含 API Key)仅保存在**本机**,不上传任何服务器
- 仓库代码不含任何真实密钥,请勿将含密钥的 `config.json` 提交到公开仓库
- Lolicon 返回壁纸版权归 Pixiv 原作者所有,AI 生成内容遵守所使用模型的服务条款

## 📄 License

[MIT](LICENSE)
