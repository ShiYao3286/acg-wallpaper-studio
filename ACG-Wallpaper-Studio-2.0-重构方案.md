# ACG Wallpaper Studio 2.0 重构与升级方案

## 一、产品定位

ACG Wallpaper Studio 2.0 定位为 AI 创作 + 壁纸管理工作站。

目标工作分辨率为 1440×900，规划支持窗口最大化、还原、全屏和窗口状态记忆。当前旧版窗口可拖拽缩放，但尚无最大化、还原、全屏控制接口，也未实现窗口状态记忆。

## 二、技术路线

- 桌面容器：Electron
- 前端：原生 JavaScript、HTML、CSS
- 暂不引入大型前端框架
- Main 负责系统能力、文件、任务调度和权限边界
- Preload 负责受控 IPC API
- Renderer 负责界面展示和用户交互
- 插件通过 Provider 协议接入

## 三、目标功能页面（六大页面）

目标版本规划六大功能页面。当前旧版界面实际存在 7 个页面，其中额外包含 page-tags（标签管理）；该页面在 2.0 中是独立保留还是并入其他页面，待后续界面设计阶段确认。

1. 工作台（Workbench）：当前壁纸、最近活动、快捷操作和任务状态。
2. AI 创作（AI Creation）：提示词、随机灵感、预设、模型选择、图片生成和结果预览。
3. 图片库（Image Library）：生成图片、下载图片、历史和收藏管理。
4. 桌面管理（Desktop Management）：当前壁纸、定时轮换、游戏检测和旧脚本联动。
5. 插件中心（Plugin Center）：插件发现、安装、启用、停用、配置和状态管理。
6. 设置（Settings）：通用设置、服务配置、代理、启动行为和存储位置。

【目标态，尚未实现】当前版本 AI 生图完成后仍会自动调用 setWallpaper 应用为桌面壁纸（main.js:201），行为与旧版一致。2.0 计划在阶段 4 实现生成结果预览，并由用户明确确认后再应用；在该功能完成前，不得将其描述为当前已有能力。

## 四、核心架构

### Renderer 展示层
负责页面、交互和状态展示。不得直接访问 Node.js、文件系统或系统 API，不得直接持有插件内部对象，不得拼接不可信 HTML。

### Preload / IPC 边界
负责受控 API、IPC 白名单、参数校验、事件订阅和取消订阅。不得暴露通用 IPC、任意文件读写或任意命令执行接口。

### Main 主进程与服务层

规划拆分为：

- Task Service：统一管理生成、下载和轮换任务。
- Image Service：图片生成、下载、校验、预览和元数据。
- Wallpaper Service：设置壁纸、历史轮换和桌面状态。
- Config Service：配置读取、保存、默认值、校验和迁移。
- Secure Storage：API Key 等敏感信息的安全保存。
- Plugin Manager：插件生命周期、能力注册和权限控制。

### Provider 插件协议

插件类型：

- 文本模型 Provider
- 图片生成 Provider
- 在线图库 Provider
- 功能扩展插件

插件通过 manifest 声明身份、版本、类型和能力。插件不能直接访问主程序数据库或 Electron 窗口，调用由主程序统一调度。

## 五、豆包 Provider 接入规划

【尚未开工】当前仓库没有豆包相关依赖或实现代码。豆包是后续优先接入的 Provider，以下为规划能力，不代表已经开始开发：

1. 二维码登录
2. 登录状态和账号状态查询
3. 文本生成
4. 图片生成
5. 模型发现与模型列表
6. 统一错误处理和任务状态反馈

具体认证流程和接口以实际可验证的服务能力为准，不预设未经验证的 API。

## 六、数据结构与旧版兼容

保留并迁移验证：

- 旧版配置及其实际目录布局
- app.getPath('pictures') 对应的壁纸目录
- 收藏数据
- wallpaper_meta.json
- 壁纸历史记录和图片文件
- 旧版 PowerShell 脚本文件约定

旧版壁纸文件约定：

- current.jpg
- current.tmp.jpg
- hist_*.jpg
- history.jsonl
- wallpaper_meta.json

迁移原则：

- 先读取、识别旧数据，再设计新结构。
- 迁移前保留原始数据，不直接覆盖。
- 迁移过程可检测、可报告。
- 迁移后验证配置、收藏、历史和当前壁纸。
- 验证通过前不改变旧版数据目录和文件契约。
- 配置格式或 API Key 存储方式变化时，必须提供迁移逻辑。

规划引入 SQLite，逐步承接任务记录、图片元数据、收藏和历史索引。敏感凭据与普通业务数据分离，不得明文写入数据库。

## 七、旧脚本兼容

旧 PowerShell 脚本的核心功能集成进软件，同时保留外部脚本兼容能力。

- 旧脚本仍可按既有文件约定更新壁纸。
- 软件检测旧脚本产生的文件变化并同步状态。
- 新旧动作通过壁纸元数据回执识别。
- 不擅自改变旧脚本依赖的文件名、目录和元数据契约。
- 先完成兼容测试，再逐步迁入软件内部。

## 八、目标目录结构（规划稿）

此结构是目标建议，不代表当前仓库已存在。按阶段逐步拆分。

```text
src/
  main/
    main.js
    preload.js
    ipc/
      index.js
      channels.js
    services/
      task-service.js
      image-service.js
      wallpaper-service.js
      config-service.js
      secure-storage.js
    plugins/
      plugin-manager.js
      provider-registry.js
      plugin-protocol.js
    storage/
      database.js
      migrations/
    system/
      tray.js
      scheduler.js
      game-detection.js
      legacy-bridge.js
  renderer/
    index.html
    renderer.js
    styles/
    pages/
    components/
    state/
    services/
  shared/
    contracts/
    constants/
    validators/
plugins/
  providers/
  extensions/
assets/
tests/
docs/
```

## 九、分阶段实施路线（阶段 0–7）

### 阶段 0：旧版基线与环境确认
- 确认 ASCII 项目路径下 Electron 正常运行。
- 确认 npm 启动链路、Renderer 和主进程运行情况。
- 建立 Lolicon、AI 生图、定时轮换、游戏检测、托盘、收藏、API 服务管理的功能基线。
- 验证 pack / dist 打包。
- 完成基线 Git 提交。
- 此阶段不进行大规模重构。

### 阶段 1：基础底座
- 建立 IPC 通道和参数校验。
- 梳理主进程服务边界。
- 建立共享数据契约和错误处理约定。
- 处理基础安全问题。
- 保证旧版功能仍可运行。

阶段 0 验收发现的建议修复顺序：
1. A1：修复收藏夹图片「设为壁纸」必然失败的问题。
2. A2：避免 get-status 同步等待远程模型列表导致状态栏和预览区卡住；提供明确错误反馈。
3. A3：修复文件 watcher 将应用自身写入 current.jpg 等文件误判为旧脚本操作的问题。
4. 原缺陷第 5 项：修复 use-history 不同步 current.jpg、历史归档和元数据的问题。
5. 原缺陷第 3 项：处理 Renderer 中 7 处动态 innerHTML 拼接，避免不可信内容注入。
6. A4：为 deepMerge 增加原型污染防护，并为 save-config 增加键白名单和参数校验。
7. 原缺陷第 12 项：统一界面版本号与 package.json 版本号。
8. A5：清理 rollPreview 重复声明，恢复预期动画行为。

补充说明：原缺陷第 4 项 read-meta 条件恒真，但该 IPC 当前没有 Renderer 调用方，属于死代码，可延后处理。原缺陷第 1、2 项 API Key 明文存储及回传属于架构问题，建议在引入 Secure Storage 能力时一并解决，避免重复改造；具体落地阶段由当时的架构进度决定，不预先锁定。以上为修复建议顺序，实施前仍需逐项复核并小步提交。

### 阶段 2：插件系统
- 定义 manifest 和 Provider 协议。
- 实现插件注册、发现、启用、停用和能力调用。
- 建立插件权限边界和生命周期管理。
- 用示例 Provider 验证协议。

### 阶段 3：豆包 Provider
- 按实际认证流程实现二维码登录和状态管理。
- 接入文本、图片生成和模型发现。
- 将服务商能力封装在 Provider 内。
- 统一任务状态、错误反馈和凭据管理。

### 阶段 4：AI 创作与任务中心
- 建立统一任务中心。
- 完成提示词助手、预设和随机灵感。
- 实现生成结果预览和用户确认应用。
- 将生成、下载和应用壁纸拆成可追踪步骤。

### 阶段 5：SQLite 与数据迁移
- 设计数据库结构和版本迁移机制。
- 迁移旧配置、收藏、历史和图片元数据索引。
- 验证迁移前后数据一致性。
- 保留旧数据备份和兼容读取能力。

### 阶段 6：桌面管理与旧脚本兼容
- 完善当前壁纸、历史、收藏和定时管理。
- 集成旧 PowerShell 脚本核心能力。
- 保留旧脚本文件协议和外部调用兼容。
- 验证新旧操作并存时的状态同步。

### 阶段 7：安全、测试与发布
- 完成 Renderer、IPC、插件边界安全检查。
- 检查凭据存储、输入校验、HTML 注入和文件路径处理。
- 完成主要功能回归测试。
- 完成 Windows 打包、安装、升级和数据迁移验证。
- 整理用户文档和发布版本。

## 十、工程约束

- 唯一开发目录：E:\acg-wallpaper-studio
- 唯一开发分支：dev-v2
- 原目录和备份目录不得删除或覆盖。
- 不改变 appId：com.acg.wallpaper-studio
- 不改变 userData 目录名称：acg-wallpaper-studio
- 使用 app.getPath('pictures') 和 app.getPath('userData')，不硬编码用户个人目录。
- 旧版 PowerShell 脚本核心功能必须集成，同时保留兼容能力。
- 阶段 0 完成并提交 Git 基线前，不进行大规模重构。
- 所有结构调整分阶段、小步提交，保证可以回退。
- 当前源码尚无 console.* 日志输出；这不代表已经建立日志脱敏机制。后续引入日志系统时，必须确保不输出 API Key 等敏感信息。
- 本机启动 Electron 前必须清理继承的 ELECTRON_RUN_AS_NODE 环境变量，可使用：cmd /c "set ELECTRON_RUN_AS_NODE=&& npm start"。
- 项目必须放在纯 ASCII 路径下；已验证中文路径可能导致 Electron 启动异常。
- PowerShell 5.1 默认输出可能将 UTF-8 中文显示为乱码；判断文件内容应使用 Node 或明确指定 UTF-8 读取。
- 旧脚本使用 PowerShell 5.1 的 Set-Content -Encoding UTF8 写入 JSON 时可能产生 BOM；当前 JSON.parse 未剥除 BOM，需在旧脚本兼容阶段修复并验证。
- electron-builder 生成的 latest.yml 中安装包文件名与实际中文 artifactName 不一致；手动分发不受影响，接入 autoUpdater 前必须修复并验证。

## 十一、当前执行位置与各阶段验收状态

当前阶段：**阶段 1 基础底座已完成实现与自检，通过小白龙三轮独立代码审核；最终验收测试 454/454 通过。工作区改动尚未提交，等待提交授权。**
阶段 0 已随基线提交（`242d551` → `a431c89`）正式关闭。

> 本节只记录**已有实测证据**的事实。计划中但未实现的能力一律列在「尚未完成」或「延期至阶段 2」，不得写成已实现。

### 已完成并有实测证据
- 项目迁移至纯 ASCII 路径，Electron 启动路径问题已定位。
- npm start 启动链路验证通过。
- Renderer 冷启动 CDP 全量捕获：exceptionThrown=0、console.error=0、Network.loadingFailed=0，4 个请求均返回 200。
- 主进程无异常堆栈；窗口和界面正常显示。
- Win11 托盘 tooltip 已通过 UIAutomation 实测。
- 功能基线 7/7 通过，包含 Lolicon 取图、真实换图、历史归档、收藏链路等验收项目。
- 三次真实换图后 current.jpg、history.jsonl 和历史归档均按预期变化；TranscodedWallpaper 修改时间同步更新，证明实际调用了系统壁纸设置能力。
- npm run pack 与 npm run dist 均成功；打包后的安装程序已实测启动，约 1.79 秒出现窗口。
- 原有 12 项缺陷已复核：真实 10 项、部分成立 2 项、不成立 0 项；另发现 A1～A5 五项遗漏问题。
- 已完成方案与当前代码差异核对，并记录环境陷阱及发布前待处理项。

### 尚未完成
- 阶段 0 Git 基线提交尚未完成。验收报告记录当时工作区仅有未跟踪的方案文档，HEAD 为 242d551，分支为 dev-v2。
- 方案文档修订完成后，需要提交 Git 基线，再正式关闭阶段 0。

### 阶段 0 验收结论
启动、功能、打包三项硬指标均已通过，但 Git 基线尚未提交，因此当前裁定为条件性通过，而非完全通过。

---

### 阶段 1 验收状态（基础底座）

#### 已完成并有实测证据

| 阶段 1 总目标（第九节） | 状态 | 证据 |
|---|---|---|
| 建立 IPC 通道和参数校验 | **完成** | 30 通道全建立、preload 双向齐平；**17 个有参数通道全部有显式校验，13 个无参数通道不加断言**（完整清单见下方「30 个 IPC 通道分类表」） |
| 梳理主进程服务边界 | **部分完成** | 已拆出 `services/config-service.js`（87 行）、`system/tray.js`（54 行）、`system/scheduler.js`（32 行）；`main.js` 由 1149 行降至拆分后约 1050 行，随后因补齐参数校验、错误契约与回滚处理，当前为 **1207 行**。净变化以独立性提升衡量，不以行数减少衡量。**未拆** `wallpaper-service`（与 `currentPath()`/`markSelfWrite()`/watcher 深度耦合，按「小步提交」原则延期） |
| 建立共享数据契约和错误处理约定 | **完成** | `shared/contracts.js` 定义 `ok()/fail()/failFrom()` + 6 个错误码；`failFrom()` 已在 `buildFailureResult()` 实际使用；错误码实测生效（`E_INVALID_ARG`/`E_NET`/`E_ROLLBACK` 均有运行时验证） |
| 处理基础安全问题 | **部分完成** | 已做：上下文隔离、原型污染防护、配置键白名单、HTML 注入改造、单实例锁、config 原子写、路径穿越拦截。**未做**：CSP、API Key 明文存储（后者按本节第 192 行属既定延期项） |
| 保证旧版功能仍可运行 | **完成** | 五个旧文件契约全部保留；BOM 兼容已在真实旧脚本产物上验证（C 盘带 BOM 回执可正确解析）；新旧两代 `history.jsonl` 记录共存 24 行无异常 |

**修复清单 8 项（第九节 182–190 行）**

| 编号 | 状态 | 证据 |
|---|---|---|
| A1 收藏夹「设为壁纸」 | 已完成 | `use-history` 先查壁纸目录再查 `favorites/` |
| A2 get-status 同步等待模型列表 | 已完成 | 改缓存 + 异步刷新；**失败反馈已补**（`modelsCacheError` → `get-status.imageModelsError` → 状态栏展示） |
| A3 watcher 误判自身写入 | 已完成 | `markSelfWrite` 5s 窗口；未提交改动把标记前移到归档前 |
| 原缺陷 5 use-history 不同步 | 已完成 | 归档 + 写 current + 写 `history.jsonl` + 写回执 + 失败回滚 |
| 原缺陷 3 Renderer 7 处 innerHTML | 已完成 | 全改 DOM API；残留仅 `innerHTML = ''` 清空赋值，无注入面 |
| A4 deepMerge 原型污染 + save-config 白名单 | 已完成 | 污染键拦截 + 顶层键白名单 + **复合键（services/promptPresets）元素级校验**，堵住 save-config 旁路 |
| 原缺陷 12 统一版本号 | 已完成 | `package.json` = `index.html` = 1.3.1 |
| A5 rollPreview 重复声明 | 已完成 | 仅 `renderer.js:225` 一处定义 |

**本轮（阶段 1 收尾）新增完成的内容**

1. **参数校验补齐 5 个通道**：`add-tag`、`remove-tag`（非空 + trim + ≤60 字符）、`roll-random-prompt`（枚举白名单 any/portrait/scenery/custom，缺省 any）、`ai-assist-prompt`（≤2000 字符）、`set-autorun`（严格布尔，拒绝 `"false"`/`1`/`"true"`）。
2. **服务边界拆分**：新增 `services/config-service.js`（`loadConfig`/`saveConfig`/`deepMerge`）、`system/tray.js`（`trayIcon`/`buildTrayMenu`）、`system/scheduler.js`（`applySchedule`）。依赖方向单向：`main.js → services/system → shared`；子模块不反向 require `main.js`，无循环引用（测试 C4–C10 验证）。`electron` 全局与业务状态均通过 `init()` 参数注入。
3. **错误契约落地**：新增 `classifyError()` 把异常按性质映射到 `E_NET`/`E_IO`/`E_NOT_FOUND`/`E_STATE`；`buildFailureResult()` 改用 `failFrom()`，回滚异常时 `code = E_ROLLBACK` 并**同时保留 `originalError` 与 `rollbackErrors`**。
4. **只读通道失败语义明确化**：`get-config` 损坏时回退默认配置、`list-*` 返回空数组、`read-meta` 返回 `null`、`get-autorun` 失败返回 `false`。全部为「可辨识的安全值」，不伪造成功数据。

#### 未完成 / 延期

| 项 | 归属 | 原因 |
|---|---|---|
| 13 个通道无显式校验 | —— | 均为**无参数**通道，不存在可校验的入参，加断言无意义（完整清单见下方分类表） |
| `wallpaper-service` 拆分 | 阶段 2 | 与 `currentPath()`/`markSelfWrite()`/watcher/`changing` 锁深度耦合，拆分等于重构核心流程，与「小步提交、可回退」冲突 |
| 存量通道统一返回格式 | 阶段 2 | 只读通道（`get-config`/`list-*` 等）无失败可能，包 `ok()` 属形式统一，需同步改 `renderer.js` 15 处调用，收益不抵风险 |
| CSP | 阶段 2 | `index.html` 有 29 处内联 `onclick`，加 CSP 前必须先移除内联事件；且本轮无实机验证 CSP 不影响冷启动的条件 |
| API Key 安全存储 | 阶段 7（Secure Storage） | 本节第 192 行已明确属架构问题，不预先锁定阶段 |
| `ERROR_CODES` 中 `E_IO`/`E_NOT_FOUND` | —— | `E_NOT_FOUND` 在最终验收中已获真实 Electron 运行时证据（`delete-favorite` 对不存在文件返回 `{"ok":false,"code":"E_NOT_FOUND"}`，属显式 `fail()` 分支）。`E_IO` 仍**无端到端运行时证据**：`classifyError()` 有分类逻辑与代码路径，但无法构造真实磁盘满/权限拒绝场景。`E_INVALID_ARG`/`E_NET`/`E_ROLLBACK`/`E_STATE` 已实测 |

#### 30 个 IPC 通道分类表（口径：按形参数量统计，与校验覆盖分开记录）

**统计说明**：
- 「有参数」= handler 形参除 `e` 之外还有实参；
- 「有显式校验」= 该通道内存在 `assert*` / `argFail` / `typeof` / `path.basename` 等实际校验调用；
- 两者是**不同维度**：无参数通道不可能有校验，不能算作「已校验」。

**A. 有参数通道 17 个（全部有显式校验）**

| # | 通道 | 形参 | 校验方式 |
|---|---|---|---|
| 1 | `save-config` | key, val | key 类型 + 点路径白名单 + 原型污染键；services/promptPresets 整数组走 `assertService`/`assertPreset`，点路径走 `assertServiceField`/`assertPresetField` |
| 2 | `change-wallpaper` | reason | `assertReason` 枚举 |
| 3 | `use-history` | name | `path.basename` + 存在性 |
| 4 | `set-autorun` | on | `assertBool` 严格布尔 |
| 5 | `add-tag` | tag | `assertTag`（非空+trim+≤60） |
| 6 | `remove-tag` | tag | `assertTag`（同） |
| 7 | `save-service` | svc | `assertService` 全字段 |
| 8 | `delete-service` | id | `assertId` |
| 9 | `set-active-service` | kind, id | `assertKind` + `assertId(allowEmpty)` |
| 10 | `test-service` | svc | `assertService` |
| 11 | `fetch-models` | svc | `assertService` |
| 12 | `roll-random-prompt` | mode | `assertRandomMode` 枚举 |
| 13 | `ai-assist-prompt` | userTheme | `assertTheme`（字符串+≤2000） |
| 14 | `save-preset` | preset | `assertPreset` |
| 15 | `delete-preset` | id | `assertId` |
| 16 | `delete-favorite` | name | `assertFavoriteName` 白名单（`fav_yyyyMMdd_HHmmss.jpg`）+ `path.basename` 双重校验 |
| 17 | `read-meta` | fileName | `assertId` |

**B. 无参数通道 13 个（不加断言）**

`get-config`、`list-history`、`get-status`、`get-autorun`、`open-wallpaper-dir`、`disable-old-task`、`detect-proxy`、`query-old-task`、`win-minimize`、`win-close`、`list-services`、`favorite-current`、`list-favorites`

**核对结果**：17 + 13 = 30，与 `preload.js` 暴露的 30 个通道双向完全一致（无缺失、无多余）。

#### 阶段 1 自检结果

最终验收（第三轮审核通过后执行，2026-11-15）：

- 语法：**29 个 JS 文件**（10 个源码 + 19 个测试/mock/baseline）`node --check` 全通过。
- 测试：**454 项断言全部通过，失败 0，无异常退出组**。分布：t1 44 / t2 39 / t3 32 / t4 35 / t5 37 / t6 26 / t7 27 / t8 16 / t9 25 / t10 69 / t11 41 / t12 63，总耗时 48.5s。测试通过模块钩子加载**真实 `main.js`**，非复刻逻辑。
- IPC 契约：`ipcMain.handle` 30 个 = `preload.js` 暴露 30 个，双向无缺失、无多余、无重复。
- 真实 Electron 33.4.11 启动验证：窗口 `ACG壁纸工作室` 正常、30 个 preload API 可用、品牌栏 `v1.3.1`、`exceptionThrown=0`、`console.error=0`。
- 用户数据完整性：验收前后 D 盘 7 文件 / C 盘 5 文件 **SHA256 逐字节一致**（12 个文件全部一致），`favorites` 0 项未变，无 `.tmp` 残留，无 electron 残留进程。
- `git diff --check` 通过（exit=0，仅有既存 CRLF 转换提示，非错误）。
- 硬约束核对：`appId` = `com.acg.wallpaper-studio`；`package.json name` = `acg-wallpaper-studio`（`userData` 目录名由此推导，代码未用 `setPath` 覆盖）；无硬编码 `C:\Users` / `D:\360MoveData`；旧文件协议五件套全部保留；`contextIsolation=true`、`nodeIntegration=false`、单实例锁在位；源码 0 处 `console.*` 调用，无密钥泄露面。
- 外链风险面：无 `shell.openExternal`、无 `<webview>`、无 `window.open`；唯一 `shell.openPath` 用于打开内部常量壁纸目录，非用户可控路径。

#### 已知风险（阶段 1 未解决）

| ID | 风险 | 等级 |
|---|---|---|
| C2 | `wallpaper_meta.json` 的 `time` 字段两种格式并存（旧脚本 `yyyy-MM-dd HH:mm:ss` vs 软件 `toLocaleString('zh-CN')`） | 低（UI 仅字符串展示） |
| C3 | 旧脚本硬编码 `$env:USERPROFILE\Pictures`，软件用 `app.getPath('pictures')`；本机两者指向不同目录，导致「旧脚本联动」实际未生效 | 中 |
| C4 | `histFile` 为新增可选字段，旧脚本不读取，向后兼容；但尚未写入 README | 低 |
| R4 | `archiveCurrent` 的 `history.jsonl` 回写是读-改-写，与旧脚本并发时有覆盖窗口 | 低（既有设计） |

#### 阶段 1 验收结论

**通过，可以进入阶段 2。** 五项目标中 3 项完成、2 项部分完成，部分完成项均已明确归属，不阻塞进入下一阶段：

| 阶段 1 总目标 | 判定 | 缺口与归属 |
|---|---|---|
| 建立 IPC 通道和参数校验 | 完成 | 无 |
| 梳理主进程服务边界 | 部分完成 | `wallpaper-service` 未拆，延期阶段 2 |
| 建立共享数据契约和错误处理约定 | 完成 | `E_IO` 无端到端运行时证据（已标注） |
| 处理基础安全问题 | 部分完成 | CSP 延期阶段 2；API Key 明文存储延期阶段 7 |
| 保证旧版功能仍可运行 | 完成 | 已知风险 C3 旧脚本联动未生效，阶段 6 修复 |

审核过程：小白龙三轮独立代码审核。第一轮裁定 `needs_revision`（发现 R1–R8 共 8 项）；第二轮发现 4 项新问题（配置覆盖风险、`assertService`/`assertPreset` 返回值被丢弃、`assertTheme` 接受 `null`/`undefined`、测试资产在仓库外）；第三轮裁定 **通过**，未发现新的阻断性问题。

#### 遗留改进建议（非阻断，不计入阶段 1 交付）

| ID | 建议 | 来源 |
|---|---|---|
| N1 | `tests/t12-round3-fixes.js` 的 Renderer 失败反馈部分目前是静态源码核验，建议后续补行为测试，覆盖 `saveAsPreset`/`saveService`/`deleteService`/`setActive` 的 IPC 失败与 Promise rejection 场景 | 小白龙第三轮 |
| N2 | `t10-stage1-complete.js` 的小结行使用 `====` 前缀，其余 11 个测试文件用 `----`，导致 `run-all.js` 汇总时该组通过数显示为空。用例实际执行 69/69 全通过，属输出格式不一致 | 本次验收发现 |
| N3 | 旧目录 `E:\ai处理文件\acg-wallpaper-studio`（7380 文件）与备份 `acg-wallpaper-studio-backup-20261114`（43 文件）仍保留，删除需用户确认 | 既有约束 |

---

### 后续待处理的发布与兼容事项
- 新机器或 CI 环境可能遇到 winCodeSign 符号链接权限问题，需记录可复现的构建处理方式。
- 当前安装包未签名，正式分发前需评估代码签名和 SmartScreen 影响。
- latest.yml 中的安装包 URL 与实际中文安装包文件名不一致，接入 autoUpdater 前必须修复。
- PowerShell 5.1 写入 JSON 的 BOM 兼容问题必须在旧脚本兼容测试中覆盖。

执行纪律：阶段 1 已完成实现，通过小白龙三轮独立代码审核，并完成最终验收（454/454）。**工作区改动尚未提交，提交需单独授权。** 进入阶段 2 前，本文档「阶段 1 未完成/延期」表中的各项必须先确认归属，不得在阶段 2 交付中被当作已完成。若实际代码、接口或数据格式与规划不符，先记录差异并确认迁移策略，不得静默破坏兼容性。
