# dsh-local-llm-connect 设计文档

日期：2026-09-24
状态：待评审

## 1. 目标

让 DeepSeek Harness 直接使用本机 **llama.cpp 管理器**（`llm-manager`）中已配置的模型。

用户在管理器里维护模型列表，DSH 侧一次「同步」即可把模型拉进模型选择；选中未运行的模型时，DSH 请求管理器把它启动起来。

## 2. 事实基础（已验证）

| 事实 | 验证方式 | 结果 |
|---|---|---|
| llama-server 是 OpenAI 兼容端点 | 实起实例 + 请求 | `/v1/models`、`/v1/chat/completions`、`/health` 均正常 |
| `/v1/models` 提供丰富元数据 | 读取响应 | `id`、`owned_by=llamacpp`、`meta.n_ctx`、`meta.n_params`、`meta.ftype` |
| 每个模型独占端口 | 读管理器配置 | 8080 / 8081 / 8082 |
| 模型别名由 `--alias` 决定 | 启动参数 | `Qwen3-VL-8B` |
| 管理器配置可读 | 读文件 | `%APPDATA%\llm-manager\models.json` |
| **管理器无任何对外接口** | 全文检索源码 | **无 HTTP server、无 CLI 入口** |

最后一条是本次设计的关键约束：**自动启动必须先在管理器侧新增接口**。

## 3. 架构

```
DSH 插件 (dsh-local-llm-connect)
    │
    ├─ 只读 ──► %APPDATA%\llm-manager\models.json      （模型配置来源）
    │
    ├─ HTTP ──► 127.0.0.1:8765                          （管理器控制 API，新增）
    │               └─► spawn llama-server.exe
    │
    └─ HTTP ──► 127.0.0.1:8080 | 8081 | 8082            （各模型 OpenAI 端点）
```

**为什么控制 API 走管理器而不是插件直接 spawn**：
管理器已实现进程管控、端口占用检测、单实例约束、就绪轮询、日志缓冲。插件绕过它直接 spawn 会产生两个进程管理者，互相不知道对方存在——管理器界面会显示「未运行」而实际在跑，用户点停止可能杀掉插件拉起的进程。控制权必须单一。

## 4. 组件拆分

### A. llm-manager 侧：本地控制 API（新增）

新文件 `src/api-server.js`，绑定 `127.0.0.1:8765`。

| 端点 | 方法 | 用途 | 返回 |
|---|---|---|---|
| `/status` | GET | 各模型运行状态 | `{ models: [{id, running, port, pid}] }` |
| `/start` | POST | 启动模型 `{id, ctxK?}` | `{ok, port, pid}` 或 `{ok:false, error}` |
| `/stop` | POST | 停止模型 | `{ok}` |

**安全**：
- 只绑 `127.0.0.1`，不对外网暴露
- 每次启动生成随机 token，写入 `%APPDATA%\llm-manager\api-token.txt`（仅本用户可读）
- 请求需带 `Authorization: Bearer <token>`
- 端口被占用时 API 静默不启动，不影响管理器主体功能

**复用**：直接调用现有 `startModel()` / `stopModel()` / `probeStatus()`，不重写逻辑。

### B. DSH 插件侧：`dsh-local-llm-connect`

| 模块 | 文件 | 职责 |
|---|---|---|
| 发现 | `src/discovery.ts` | 定位配置目录与 API 端口，探测管理器是否在跑 |
| 配置读取 | `src/config-store.ts` | 解析 `models.json`，容错处理 |
| 适配器 | `src/adapter.ts` | 每个模型注册为独立 provider，走 OpenAI 兼容协议 |
| 控制 | `src/control-client.ts` | 调用管理器 API 启动/停止/查状态 |
| 入口 | `src/index.ts` | Cordis 插件：`name`/`inject`/`Config`/`apply` |
| 客户端 | `src/client/index.ts` | 配置页 UI：同步按钮、模型列表、状态指示 |
| 清单 | `cordis.patch.yml` | 插入插件行 |

### C. 数据流

**同步流程**

```
用户点「同步」
  → discovery 定位 models.json
  → config-store 解析出模型数组
  → 对每个模型调 /status 或在无 API 时探测端口
  → adapter 注册/更新 provider
  → client 刷新列表显示
```

**选中未运行的模型**

```
DSH 请求该 provider
  → adapter 先查状态
  → 未运行 → 调管理器 /start
  → 轮询端口直到就绪（超时上限）
  → 转发请求到该端口
  → 启动失败 → 返回明确错误，不静默失败
```

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| 管理器未安装 | 配置页提示「未检测到 llama.cpp 管理器」，不注册任何 provider |
| 管理器在跑但 API 未开（旧版本） | 降级为只读同步，模型列出但标记「无法自动启动」 |
| API token 不匹配 | 提示用户重启管理器以刷新 token |
| 模型文件缺失 | 该模型列出但标记不可用，选中时给明确错误 |
| 启动超时 | 返回「启动超时（N 秒）」，附管理器日志提示 |
| 端口被非 llama 进程占用 | 明确报「端口 X 被占用」，不盲目转发 |

**原则**：任何一步失败都要让用户知道**具体是哪一步、为什么**，不吞错误、不静默降级。

## 6. 测试策略

| 层 | 方式 |
|---|---|
| 配置解析 | 单测：正常配置、缺失文件、字段缺失、编码异常 |
| 发现逻辑 | 单测：注入假文件系统，覆盖多候选路径 |
| 控制客户端 | 单测：mock HTTP，覆盖成功/401/超时/连接拒绝 |
| 适配器 | 单测：验证 provider 注册与请求转发 |
| 端到端 | 实起 llama-server 验证真实转发 |

测试不依赖真实管理器，全部可注入。

## 7. 边界（明确不做的）

- 不做模型下载或量化转换
- 不做管理器 GUI 的替代品
- 不修改管理器的现有行为
- 不处理多机/远程 llama-server（仅本机）

## 8. 致谢

本项目结构参考 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（作者 corrinehu，MIT）。该项目的 DSH 插件组织方式、`dsh.bundle` 清单写法与 client/host 分层是本设计的直接依据。

与参考项目的差异：WorkBuddy 场景需要逆向加密凭据、伪造 UA、自建 shim 代理；本项目上游是**标准 OpenAI 兼容端点**，因此适配层大幅简化，复杂度集中在**服务发现与进程控制**。

## 9. 待确认

- [ ] 管理器控制 API 的端口 8765 是否有冲突风险
- [ ] token 文件位置是否合适
- [ ] 是否需要支持手动指定上游地址（非管理器管理的 llama-server）
