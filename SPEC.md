# dsh-token-usage — 实现契约（内部规格）

DSH 插件：左侧栏「余额」面板，显示当前会话模型提供商的余额；点击后在主面板展开
本会话 / 今天 / 近 7 天 / 近 30 天 / 历史累计的 token 与费用统计，并可编辑单价
（含峰谷与长短上下文分层价格）与手动余额。

## 包结构

```text
dsh-token-usage/
  package.json          # dsh.bundle.patch + dsh.client
  cordis.patch.yml      # 插入 host 行
  index.js              # Host half: apply(ctx), 注册 /token-usage/api 路由
  store.js              # 状态文件读写 + 默认值 + 归一化
  stats.js              # 纯函数：价格分层、单次调用计费、区间聚合
  engine.js             # Host 会话语料读取 + 缓存 + overview 组装
  client.js             # Client half: sidebar.panellist + main 面板（window.__ModuleLoader__）
  locale/en.json        # 插件元数据（插件管理页）
  locale/zh.json
  icon.svg
  README.md
  test/stats.test.mjs
```

## 状态文件（Host 持久化）

位置：`$DSH_HOME/token-usage/state.json`（`DSH_HOME` 缺省 `~/.dsh`），原子写入。

```jsonc
{
  "version": 1,
  "currency": "CNY",              // 仅显示用符号，可为任意字符串
  "models": {
    // key = `${provider}/${model}`
    "cnit/deepseek-flash": {
      "base":   { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, // 每百万 token
      "valley": null,             // 或同一形状的四字段对象
      "long":   null,             // 或同一形状的四字段对象
      "valleyWindow": { "start": "18:00", "end": "09:00", "weekends": false, "holidays": false },
      "holidays": ["2026-10-01"], // 本地自然日 YYYY-MM-DD
      "longContextThreshold": 272000
    }
  },
  "balances": {
    // 手动余额。remaining = amount - (当前全时费用 - baselineCost)
    "cnit": { "amount": 100, "baselineCost": 3.21, "updatedAt": 1690000000000 }
  }
}
```

## 计费规则（`stats.js`，纯函数，可单测）

单次调用（一个含 `usage` 的 `assistant/message` 事件）：

- `promptTokens = input + cacheRead + cacheWrite`
- 价格分层优先级：**长上下文 > 峰谷 > 基础价**
  - 长上下文：`longContextThreshold > 0` 且 `long` 存在且 `promptTokens > threshold`
  - 峰谷：`valley` 存在，且调用时刻命中谷时窗口 / 周末 / 节假日
  - 未命中或该层未配置 → `base`
- `cost = (input*pi + output*po + reasoning*po + cacheRead*pcr + cacheWrite*pcw) / 1e6`
- 谷时窗口：本机时区；`start <= t < end`，`start > end` 时视为跨午夜；周末=周六/周日整天；
  节假日 = `holidays` 中 `YYYY-MM-DD` 整天。
- 统计口径：本会话 / 今天 / 近 7 天（含今天）/ 近 30 天（含今天）/ 历史累计，按本机自然日。

## Host HTTP API

前缀 `/token-usage/api`，仅 `POST`，`content-type: application/json`。
请求体：`{ "action": string, "payload": object }`。响应：`{ ok: true, value }` 或
`{ ok: false, error: { code, message } }`（HTTP 400/500）。
使用 `ctx.get('connection')?.requestRejection(req)` 做授权校验。

### `action: "overview"`

`payload: { sessionId?: string }` → `value: Overview`：

```jsonc
{
  "generatedAt": 1690000000000,
  "sessionId": "session-12" | null,
  "sessionProvider": "cnit" | null,               // 当前会话最新 request/context 的提供商，无则取最近用量的提供商
  "sessionProviders": ["cnit"],                   // 当前会话（含子代理）真正产生用量的提供商，新→旧
  "currency": "CNY",
  "config": { /* 与 state.json 完全一致的归一化状态 */ },
  "providers": [ { "id": "cnit", "name": "CNIT" } ],
  "models": [ { "id": "cnit/deepseek-flash", "provider": "cnit", "model": "deepseek-flash", "priced": true } ],
  "balances": [ { "provider": "cnit", "name": "CNIT", "hasBalance": true, "amount": 100, "remaining": 96.79 } ],
  "periods": {
    "session": { "calls": 12, "cost": 1.23, "tokens": Token, "models": [ ModelUsage ] },
    "today":   { ... }, "week": { ... }, "month": { ... }, "all": { ... }
  },
  "daily": [ { "day": "2026-11-12", "tokens": Token, "cost": 0.42 } ],   // 近 14 天，含今天，按天升序
  "unpriced": ["cnit/deepseek-flash"],  // 命中但未定价的模型（费用显示 *）
  "incomplete": false                   // 会话列表或会话读取失败时为 true
}
```

- `Token = { input, output, cacheRead, cacheWrite, reasoning, total }`，
  `total = input+output+cacheRead+cacheWrite`。
- `ModelUsage = { id, provider, model, calls, cost, tokens: Token }`，按 cost 降序。
- `periods.session` 只统计当前会话及其**子代理后代会话**（header.origin === 'subagent'
  或 delegationDepth > 0 的后代，递归）。

### `action: "saveConfig"`

`payload: { config }`（客户端回传完整 config；Host 归一化并整体替换 models/currency，
`balances` 不受影响）→ `value: { config }`。

### `action: "saveBalance"`

`payload: { provider, amount: number|null }`。`amount === null` 表示清除。
Host 计算该 provider 的当前全时费用，写入 `{ amount, baselineCost, updatedAt }`
→ `value: { balances }`（同 `overview.balances`）。

## Client Half（`client.js`）

`window.__ModuleLoader__.load({ id: 'dsh-token-usage', factory(require) { ... } })`。
工厂返回 `{ inject: ['slots', 'locale', 'layout'], apply(ctx) {} }`。

- `NS = 'dsh-token-usage'`；`ctx.effect(() => ctx.locale.register(NS, { zh, en }))`。
- `PANEL_ID = 'token-usage'`。
- 注册 `sidebar.footer.action`（侧栏底部页脚区）：`{ name, id: PANEL_ID, order: 30, locale: NS, label: () => t('panel') }`，
  组件接收 owner props `{ wide }` 与标准 props；渲染钱包图标 + 文案：有手动余额时直接显示
  「提供商名 + 剩余余额」（两位小数，不显示币种代码），点击调用 `ctx.layout.selectPanel(PANEL_ID)`。
  查询 overview 时与面板相同（每 30s + visibilitychange + 保存后的 `dsh-token-usage:changed` 事件）。
- 注册 `main`：`{ name: 'main', key: PANEL_ID, locale: NS }`，组件接收标准 props
  `{ useSessions }`；用
  `useSessions(s => Object.values(s.byId).find(x => (x.retainedBy?.mainView ?? 0) > 0)?.id)`
  取当前会话 id。
- 请求：`fetch(new URL('token-usage/api', document.baseURI), { method:'POST', headers, body })`；
  每次 `overview` 带当前 sessionId；保存后重新拉取 overview。
- 只能使用主题 token（`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2`、
  `--dsw-alias-bg-overlay`、`--dsw-alias-border-l1/l2`、`--dsw-alias-label-primary/secondary`、
  `--dsw-alias-brand-primary`、`--dsw-alias-state-error/success/warn/idle-primary`）与自有
  `.__tu_*` 类名；不得 import 任何 `@deepseek-ai/*` 包；React 来自 `require('react')`。
- UI 内容：
  1. 顶部：标题「余额」+ 刷新按钮 + 关闭按钮（`ctx.layout.selectPanel(null)` 回到对话）；
     当前会话涉及提供商的余额卡片（剩余金额；未设置显示
     「未设置」；无会话显示提示）。
  2. 统计：5 个口径行（本会话/今天/近 7 天/近 30 天/历史累计）显示费用；token 明细行与
     缓存命中率同一行，命中率排在「合计」之后（cacheRead / (input + cacheRead + cacheWrite)，
     prompt 为 0 时显示 `—`）；
     可点选一个口径；下方「按模型」表（含缓存命中率列）+ 近 14 天费用柱状图，
     柱子悬停或键盘聚焦时显示当天日期、费用与 token 数的浮动提示（提示限制在图表内）。
  3. 「价格」编辑：货币、每个已观察模型的 4 个基础单价 + 谷时（窗口、周末、节假日、
     4 个单价）+ 长上下文（阈值、4 个单价）；保存按钮。
  4. 「余额」编辑：当前会话涉及的提供商（无会话时用全部已观察提供商）逐个填写余额；
     保存按钮位于该分区标题行右侧（与「价格」编辑的保存按钮对齐）。
- 未定价模型费用后标 `*`。

## 安装

```bash
# 由 Lead 通过 plugin_manager install_bundle 安装目录
```
