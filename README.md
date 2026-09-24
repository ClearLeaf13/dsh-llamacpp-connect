# dsh-llamacpp-connect

把本地 **llama.cpp 管理器**里**正在运行**的模型接入 [DeepSeek Harness](https://www.deepseek.com/harness/)，启动即出现、停止即消失。

Bring the models **currently running** in your local **llama.cpp manager** into DeepSeek Harness.

---

## 它做什么

你在 llama.cpp 管理器里维护模型、决定谁在跑。这个插件让 DSH 的模型选择列表**始终等于你当前正在运行的那几个模型**：

1. **自动发现**本机的 llama.cpp 管理器，读出它维护的模型列表
2. **只注册正在运行的模型**——每个模型一个独立 provider，在模型选择里单独成组
3. **自动跟随**——每 15 秒重新评估一次；你在管理器里启动或停止模型，列表自动增删，不需要手动操作
4. 配置页可以查看当前状态，也可以点**「立即刷新」**马上同步一次

跑不起来的模型不会出现在列表里：判定不了运行状态时（管理器没开、或版本过旧没有控制接口），插件**一个模型也不列**，而不是让你选到一个必然报错的条目。

---

## 前置条件

| 依赖 | 说明 |
|---|---|
| [DeepSeek Harness](https://www.deepseek.com/harness/) | 宿主 |
| [llm-manager](https://github.com/ClearLeaf13/llm-manager) | 本地 llama.cpp 管理器，**v1.2.0 或更高**（需要其控制接口） |
| llama.cpp | 由管理器自行管理，本插件不直接调用 |
| Node.js | ^22.19.0 或 >=24 |

**控制接口说明**：判断「谁在运行」依赖管理器的本地控制 API（`127.0.0.1:8765`，带一次性令牌）。管理器版本低于 v1.2.0、或管理器当前没在运行时，插件**无法获知运行状态**，此时它不会列出任何模型（配置页会说明原因并给出「立即刷新」按钮）。打开管理器后约 15 秒内自动恢复。

---

## 安装

```bash
dsh plugin --profile web add dsh-llamacpp-connect
```

装好后重启 DSH Web UI。

验证是否加载：

```bash
dsh --profile web --dump-config
```

应能在插件树里看到 `llamacpp-connect` 一行。

---

## 使用

### 首次使用

1. 打开 **llama.cpp 管理器**，确认里面已经配置好模型
2. 在管理器里**启动**你要用的模型
3. 打开 **DSH 设置 → llama.cpp Connect** 可以看到当前有几个在运行（也可直接看模型选择列表）

正在运行的模型会自动出现在 DSH 的模型选择器里，每个模型单独成组。

### 启动 / 停止模型

在 llama.cpp 管理器里操作即可，DSH 侧会自动跟上：

- **启动**一个模型 → 约 15 秒内出现在模型选择列表里
- **停止**一个模型 → 约 15 秒内从列表里消失

想立刻生效，就到配置页点一次 **「立即刷新」**。

> 注意：如果某个模型正被对话使用，而你在管理器里把它停掉了，它会在下一轮刷新时被移除，该对话后续请求会失败。

### 管理器里改了配置之后

比如改了模型名、别名或端口：插件在下一轮刷新时自动读到，也可以点 **「立即刷新」** 马上应用。插件只读管理器的配置，不会改写它。

---

## 配置项

| 项 | 默认 | 说明 |
|---|---|---|
| `managerDir` | 自动探测 | 手动指定管理器数据目录；留空则依次探测常见位置 |

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: llamacpp-connect
  config:
    managerDir: 'D:\path\to\llm-manager'
```

重新评估运行状态的间隔固定为 15 秒；需要立刻生效时用配置页的「立即刷新」按钮。

---

## 工作原理

```
DSH 插件
    │
    ├─ 只读 ──► %APPDATA%\llm-manager\models.json     模型配置来源（有哪些模型）
    │
    ├─ HTTP ──► 127.0.0.1:8765/status                 谁在运行（每 15 秒问一次）
    │
    └─ HTTP ──► 127.0.0.1:<port>/v1                   运行中模型的 OpenAI 兼容端点
```

**插件不启动、不停止任何模型**：进程管控完全属于管理器（端口占用检测、就绪轮询、日志缓冲都在那里）。插件只做两件事——读配置、看谁在跑——然后把运行中的模型注册给 DSH。这样不会出现两个互不知情的进程管理者（管理器显示「未运行」而进程实际在跑的那种状态）。

**只在运行集合变化时才重新注册**：否则每 15 秒都会拆装一遍 provider，正在进行的请求会被打断。集合（含端口）没变时刷新是空操作。

### 模型进入列表的判据

只有管理器控制接口报告 `running: true` 的模型才会被注册。判定不了运行状态时**一个也不注册**——宁可列表为空，也不让人选到一个必然报错的模型。

---

## 常见问题

**配置页显示「未检测到 llama.cpp 管理器」**

管理器没装，或数据目录不在探测范围内。装了的话，用 `managerDir` 手动指定。

**配置页显示「运行中 0 / 共 N 个模型」**

模型都配置好了，但一个都没在跑。到 llama.cpp 管理器里启动你要用的模型，约 15 秒内会自动出现。

**显示「无法获知运行状态」**

管理器没在运行，或版本过旧（低于 v1.2.0）没有控制接口。**只有运行中的管理器才会写出控制接口的端口与令牌。** 打开管理器后约 15 秒自动恢复，也可以点「立即刷新」马上重试。

**模型列表是空的（配置页说「共 0 个」）**

管理器里还没配置模型，或者 `models.json` 损坏。配置页会显示被跳过的条目及原因。

**在管理器里点了停止，DSH 里还看得到那个模型**

刷新有最长 15 秒的延迟。点一次「立即刷新」即可立刻消失。

**两个模型端口相同**

插件的配置解析会跳过端口重复的条目并在配置页指出——端口冲突意味着两个 provider 会指向同一个实例，属配置错误。

---

## 开发

```bash
pnpm install
pnpm test        # 93 个测试
pnpm run build   # 产出 lib/
pnpm run check   # typecheck + test + build
```

### 源码结构

| 文件 | 职责 |
|---|---|
| `src/discovery.ts` | 定位管理器数据目录与控制接口 |
| `src/config-store.ts` | 解析 `models.json`，容错处理 |
| `src/control-client.ts` | 调用管理器控制 API（含 `/status` 运行状态） |
| `src/adapter.ts` | 模型 → pi-ai provider 映射 |
| `src/index.ts` | Cordis 插件入口：运行状态过滤、轮询、provider 注册 |
| `src/client/index.tsx` | 设置面板卡片（官方 `settings.section` 契约） |

测试分层：

- **单元测试**（`config-store` / `discovery` / `control-client` / `adapter`）不依赖真实 llama.cpp
- **契约测试**（`plugin-contract`）读源码与构建产物，锁定 DSH 加载器契约（无 default 导出、裸 require react、路由幂等、`live` 代际委派……）
- **集成测试**（`running-filter` / `model-catalog`）把**构建产物装进真实 Cordis 宿主**，配一个**假的管理器 HTTP 服务**，验证「只注册运行中的模型」「集合未变不重注册」「拿不到状态就不列」以及模型确实能被枚举出来

### 发布前预检

因为插件加载失败会让整个宿主起不来，发布前请确认：

1. 对**解包后的 npm 产物**（不是 `lib/` 目录）跑一遍集成测试
2. 产物里没有 `exports.default`（`cordis-plugin-loader` 的 `unwrapExports()` 会把组件当插件本体调用）
3. `adapter.listModels()` 能返回模型（模型选择列表的数据源；只注册成功但枚举为空是曾经的真实故障）
4. 插件的 `apply` 是**箭头函数**。普通函数有 `prototype`，会被 cordis 的 `isConstructor()` 当成类式插件用 `new callback(ctx, config)` 调用，**返回值不再被收集为 disposer** —— 副作用照常发生所以看起来正常，但卸载时轮询定时器泄漏、适配器不被撤销。
5. 手搓的 pi-ai **profile 自带官方归一化的字段**。我们绕过了 `dsh-llm-pi-ai` 的 `resolveProfiles()`（未导出），而 stream 路径**直接读取**这些字段：`streamIdleTimeoutMs`（缺失即抛 `idleWatchdog timeoutMs must be a positive finite number...`）、`maxRequestImageBytes` / `requestImagePixelBudget` / `requestImageMaxBytes`、`retryPolicy`。见 `buildAdapterProfile()` 的注释。

---

## 致谢

本项目的插件结构参考了 **[dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)**（作者 [corrinehu](https://github.com/corrinehu)，MIT）。该项目演示了 DSH 插件的组织方式、`dsh.bundle` 清单写法，以及 host 端与 client 端的分层——本插件的骨架直接受益于它，在此致谢。

设置面板卡片另行按**官方** `settings.section` 契约实现（`@deepseek-ai/dsh-client-ui-settings-general` 声明的 list slot），client 产物形态对齐官方 client 包。

两者的场景不同：WorkBuddy 需要逆向桌面应用的加密凭据、构造特定 UA、自建代理转发；而本项目上游是标准的 OpenAI 兼容端点，因此适配层简单得多，复杂度集中在**服务发现与运行状态判定**上。

---

## 许可

MIT
