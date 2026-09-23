# dsh-llamacpp-connect

把本地 **llama.cpp 管理器**里配置的模型接入 [DeepSeek Harness](https://www.deepseek.com/harness/)，一次同步，直接选用。

Bring the models configured in your local **llama.cpp manager** into DeepSeek Harness.

---

## 它做什么

你在 llama.cpp 管理器里维护模型列表——加模型、删模型、改上下文。这个插件让你不必在 DSH 里重复配置一遍：

1. **自动发现**本机的 llama.cpp 管理器，读出它维护的模型列表
2. **每个模型注册为一个独立 provider**，在 DSH 的模型选择里单独成组，直接选中即用
3. **选中即启动**——模型没在跑时，插件请管理器把它启动起来，等加载完成再转发请求
4. 配置页提供**同步按钮**，管理器里改完点一下，DSH 侧立即跟上

---

## 前置条件

| 依赖 | 说明 |
|---|---|
| [DeepSeek Harness](https://www.deepseek.com/harness/) | 宿主 |
| [llm-manager](https://github.com/ClearLeaf13/llm-manager) | 本地 llama.cpp 管理器，**v1.2.0 或更高**（需要其控制接口） |
| llama.cpp | 由管理器自行管理，本插件不直接调用 |
| Node.js | ^22.19.0 或 >=24 |

**控制接口说明**：自动启动依赖管理器的本地控制 API（`127.0.0.1:8765`，带一次性令牌）。管理器版本低于 v1.2.0 时没有这个接口，插件会**降级为只读同步**——模型仍能列出并选用，但需要你在管理器界面手动启动。

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
2. 打开 **DSH 设置 → 插件 → llama.cpp Connect**
3. 点 **「同步模型」**

同步后，模型会出现在 DSH 的模型选择器里。

### 选中一个没在运行的模型

不需要先去管理器里点启动。直接在 DSH 里选中它并发消息：

- 插件检测到端口未就绪
- 请管理器启动该模型
- 轮询等待模型加载完成（大模型可能需要几十秒到几分钟）
- 加载完成后自动转发你的请求

首次加载 24 GB 级模型时等待时间较长，属正常。

### 管理器里改了配置之后

回到配置页点一次 **「同步模型」** 即可。插件不做后台轮询，也不会自动改写你的管理器配置。

---

## 配置项

| 项 | 默认 | 说明 |
|---|---|---|
| `managerDir` | 自动探测 | 手动指定管理器数据目录；留空则依次探测常见位置 |
| `autoStart` | `true` | 选中未运行模型时是否自动启动；关掉则只给出提示 |

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: llamacpp-connect
  config:
    autoStart: false
```

---

## 工作原理

```
DSH 插件
    │
    ├─ 只读 ──► %APPDATA%\llm-manager\models.json     模型配置来源
    │
    ├─ HTTP ──► 127.0.0.1:8765                        管理器控制接口
    │               └─► 由管理器 spawn llama-server
    │
    └─ HTTP ──► 127.0.0.1:<port>/v1                   各模型的 OpenAI 兼容端点
```

**为什么通过管理器启动，而不是插件自己拉起 llama-server**：管理器已经实现了进程管控、端口占用检测、就绪轮询和日志缓冲。插件绕过它直接 spawn 会产生两个互不知情的进程管理者——管理器界面显示「未运行」而进程实际在跑，用户点停止可能杀掉插件拉起的进程。控制权必须单一。

### 就绪判据

插件以 `/health` 返回 `{"status":"ok"}` 作为「可服务」的判据，而不是端口可连接。

这一点很重要：**llama-server 会先监听端口、后加载模型**。加载期间端口是通的，但请求会收到 503。只看端口会导致「启动成功」的误判，用户紧接着发消息却拿到报错。

---

## 常见问题

**配置页显示「未检测到 llama.cpp 管理器」**

管理器没装，或数据目录不在探测范围内。装了的话，用 `managerDir` 手动指定。

**模型列表是空的**

管理器里还没配置模型，或者 `models.json` 损坏。配置页会显示被跳过的条目及原因。

**显示「仅同步（无控制接口）」**

管理器版本过旧（低于 v1.2.0），或者它当前没在运行。**运行中的管理器才会写出控制接口的端口与令牌。** 打开管理器后重新同步即可。

**选中模型后报「未运行，且无法自动启动」**

控制接口不可用。打开管理器，并在其中手动启动该模型。

**启动超时**

大模型首次加载可能超过 180 秒（尤其放在机械硬盘上）。插件默认等待 180 秒，超时后请查看管理器日志确认加载进度。

**两个模型端口相同**

插件的配置解析会跳过端口重复的条目并在配置页指出——端口冲突意味着两个 provider 会指向同一个实例，属配置错误。

---

## 开发

```bash
pnpm install
pnpm test        # 52 个单元测试
pnpm run build   # 产出 lib/
pnpm run check   # typecheck + test + build
```

### 源码结构

| 文件 | 职责 |
|---|---|
| `src/discovery.ts` | 定位管理器数据目录与控制接口 |
| `src/config-store.ts` | 解析 `models.json`，容错处理 |
| `src/control-client.ts` | 调用管理器控制 API |
| `src/adapter.ts` | 模型 → provider 映射、就绪等待 |
| `src/index.ts` | Cordis 插件入口 |
| `src/client/index.tsx` | 配置页 UI |

测试不依赖真实的 llama.cpp 或管理器，全部可注入。

---

## 致谢

本项目的插件结构参考了 **[dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)**（作者 [corrinehu](https://github.com/corrinehu)，MIT）。该项目演示了 DSH 插件的组织方式、`dsh.bundle` 清单写法，以及 host 端与 client 端的分层——本插件的骨架直接受益于它，在此致谢。

两者的场景不同：WorkBuddy 需要逆向桌面应用的加密凭据、构造特定 UA、自建代理转发；而本项目上游是标准的 OpenAI 兼容端点，因此适配层简单得多，复杂度集中在**服务发现与进程控制**上。

---

## 许可

MIT
