# ACG壁纸工作室

> 随机二次元壁纸 + AI 生图壁纸的 Windows 桌面管理工具(Electron)

![图标](assets/icon.png)

## 功能

- **双壁纸来源**:Lolicon 随机二次元图(Pixiv)/ AI 生图(gpt-image 等 OpenAI 兼容 API)
- **🎲 随机灵感模式**:完全随机 / 锁定人物 / 锁定风景,本地大词池自动拼装 Danbooru 提示词,几乎不重样
- **API 服务管理**:预设多个 API(画图/文本),拉取模型列表、连通测试,提示词助手联动文本模型
- **定时换图**:可调间隔,游戏运行时自动暂停(进程名单可配)
- **历史与收藏**:历史画廊、收藏夹、一键回设壁纸
- **系统托盘**:后台常驻,右键快捷换图
- **旧脚本联动**:兼容传统 ps1 计划任务方案,脚本换图后软件实时感知(文件监听 + 动作回执)
- **网络代理**:支持 HTTP 代理(Clash Verge 等),自动探测本机代理端口

## 开发

```bash
npm install        # 安装依赖(建议配 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/)
npm start          # 开发运行
npm run dist       # 打包 NSIS 安装包 + 免安装 zip
```

## 目录结构

```
src/
  main/          # Electron 主进程(引擎/调度/托盘/IPC)
  renderer/      # 渲染进程 UI(玻璃拟态深紫主题)
  shared/        # 默认配置与随机词池
assets/          # 图标与设计稿
```

## 说明

- Lolicon API:https://api.lolicon.app
- 默认配置不含任何密钥,首次使用请在「API 服务」页配置自己的 API
- 仅供学习交流,壁纸版权归原作者所有
