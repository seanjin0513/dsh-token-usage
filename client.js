/**
 * dsh-token-usage — browser half.
 *
 * One self-contained classic-script bundle: the ModuleLoader factory registers a
 * sidebar "余额" entry and a keyed main panel. Every number shown here is
 * computed by the Host (see index.js / engine.js); this file only fetches the
 * overview, renders it, and writes price / manual-balance edits back through
 * POST /token-usage/api.
 *
 * No package dependencies beyond `react`, no JSX, no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory: function factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;

    /* ── Constants ──────────────────────────────────────────────────────── */

    var NS = 'dsh-token-usage';
    var PANEL_ID = 'token-usage';
    var FOOTER_ORDER = 30;
    /** Host route, resolved relative to the page so reverse-proxied mounts work. */
    var API_PATH = 'token-usage/api';
    var REFRESH_INTERVAL_MS = 30000;
    var FLASH_MS = 2600;

    // Mirrors the defaults in stats.js; the client cannot reach the Host module
    // table, so the same fallbacks are restated here for empty inputs.
    var DEFAULT_CURRENCY = 'CNY';
    var DEFAULT_VALLEY_START = '18:00';
    var DEFAULT_VALLEY_END = '09:00';
    var DEFAULT_LONG_CONTEXT_THRESHOLD = 272000;

    var CURRENCY_CODE = /^[A-Za-z]{2,6}$/;
    var CLOCK_PATTERN = /^\d{2}:\d{2}$/;
    var DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

    /** The five selectable统计口径, in display order. */
    var PERIODS = [
      { id: 'session', label: 'periodSession' },
      { id: 'today', label: 'periodToday' },
      { id: 'week', label: 'periodWeek' },
      { id: 'month', label: 'periodMonth' },
      { id: 'all', label: 'periodAll' }
    ];

    /** The four billable token kinds a price set covers (per million tokens). */
    var PRICE_FIELDS = [
      { key: 'input', label: 'priceInput' },
      { key: 'output', label: 'priceOutput' },
      { key: 'cacheRead', label: 'priceCacheRead' },
      { key: 'cacheWrite', label: 'priceCacheWrite' }
    ];

    /** Token kinds shown in breakdowns; `total` is the aggregate. */
    var TOKEN_FIELDS = [
      { key: 'input', label: 'tokenInput' },
      { key: 'output', label: 'tokenOutput' },
      { key: 'cacheRead', label: 'tokenCacheRead' },
      { key: 'cacheWrite', label: 'tokenCacheWrite' },
      { key: 'reasoning', label: 'tokenReasoning' },
      { key: 'total', label: 'tokenTotal' }
    ];

    var numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    var moneyFormatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    });
    var compactMoneyFormatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    var timestampFormatter = new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    /* ── Styles ─────────────────────────────────────────────────────────── */

    var CSS = [
      '.__tu_root{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;height:100%;overflow:auto;padding:20px 24px 40px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.__tu_root *{box-sizing:border-box;min-width:0}',
      '.__tu_header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.__tu_heading{display:flex;align-items:baseline;gap:12px;flex:1;min-width:160px}',
      '.__tu_title{font-size:18px;font-weight:600;margin:0}',
      '.__tu_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.__tu_flash{font-size:12px;color:var(--dsw-alias-state-success-primary);white-space:nowrap}',
      '.__tu_button{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.__tu_button:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.__tu_button:disabled{opacity:.5;cursor:default}',
      '.__tu_button--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.__tu_button--primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);opacity:.9}',
      '.__tu_refreshIcon{display:inline-block;margin-right:4px;font-size:13px;line-height:1}',
      '.__tu_banner{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 12px;font-size:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.__tu_bannerText{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.__tu_banner--error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.__tu_banner--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.__tu_sections{display:flex;flex-direction:column;gap:14px}',
      '.__tu_section{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}',
      '.__tu_sectionTitle{font-size:14px;font-weight:600;margin:0}',
      '.__tu_subhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:2px}',
      '.__tu_subtitle{font-size:13px;font-weight:600;margin:0}',
      '.__tu_muted{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.__tu_hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.__tu_cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}',
      '.__tu_card{display:flex;flex-direction:column;gap:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px}',
      '.__tu_cardName{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:600}',
      '.__tu_cardName>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.__tu_amount{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
      '.__tu_amount--negative{color:var(--dsw-alias-state-error-primary)}',
      '.__tu_amountEmpty{font-size:14px;font-weight:500}',
      '.__tu_tag{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;font-size:10px;font-weight:400;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.__tu_tag--ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.__tu_tag--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.__tu_providerId{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.__tu_periods{display:flex;flex-direction:column;gap:6px}',
      '.__tu_period{display:grid;grid-template-columns:minmax(88px,110px) minmax(120px,150px) minmax(0,1fr);align-items:center;gap:10px;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:8px 12px}',
      '.__tu_period:hover{border-color:var(--dsw-alias-border-l2)}',
      '.__tu_period[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-overlay)}',
      '.__tu_periodName{font-weight:600;font-size:12px}',
      '.__tu_periodCost{display:flex;flex-direction:column;gap:1px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.__tu_periodCost .__tu_muted{font-weight:400}',
      '.__tu_tokens{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.__tu_token{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap}',
      '.__tu_token b{font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.__tu_tableWrap{overflow-x:auto;max-width:100%}',
      '.__tu_table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}',
      '.__tu_table th{text-align:right;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.__tu_table td{text-align:right;color:var(--dsw-alias-label-secondary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.__tu_table th:first-child,.__tu_table td:first-child{text-align:left}',
      '.__tu_table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}',
      '.__tu_modelCell{display:flex;flex-direction:column;gap:1px}',
      '.__tu_modelName{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.__tu_cost{font-variant-numeric:tabular-nums}',
      '.__tu_star{margin-left:1px;color:var(--dsw-alias-state-warn-primary);font-weight:700}',
      '.__tu_chart{display:flex;align-items:stretch;gap:4px;height:120px;padding:4px 2px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.__tu_chartDay{display:flex;flex:1;min-width:0;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px}',
      '.__tu_chartBarArea{display:flex;flex:1;width:100%;min-height:0;align-items:flex-end;justify-content:center}',
      '.__tu_chartBar{width:100%;max-width:26px;min-height:2px;border-radius:4px 4px 0 0;background:var(--dsw-alias-brand-primary);transition:height .2s}',
      '.__tu_chartBar--zero{background:var(--dsw-alias-border-l1)}',
      '.__tu_chartLabel{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;transform:scale(.92)}',
      '.__tu_chartDay{position:relative;border-radius:6px;outline:none}',
      '.__tu_chartDay--hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.__tu_chartDay:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}',
      '.__tu_tip{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);z-index:6;display:flex;flex-direction:column;gap:1px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 6px 18px rgba(0,0,0,.16);font-size:11px;line-height:1.45;white-space:nowrap;pointer-events:none;color:var(--dsw-alias-label-secondary)}',
      '.__tu_tip--first{left:calc(50% + 18px);right:auto;transform:none}',
      '.__tu_tip--last{left:auto;right:calc(50% + 18px);transform:none}',
      '.__tu_tipDay{color:var(--dsw-alias-label-tertiary)}',
      '.__tu_tipCost{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}',
      '.__tu_tipTokens{color:var(--dsw-alias-label-tertiary)}',
      '.__tu_hitRate{white-space:nowrap}',
      '.__tu_iconBtn{padding:5px 9px;font-size:14px;line-height:1.2;color:var(--dsw-alias-label-secondary)}',
      '.__tu_editorHead{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}',
      '.__tu_spacer{flex:1}',
      '.__tu_field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.__tu_fieldLabel{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.__tu_field--wide{grid-column:1/-1}',
      '.__tu_input,.__tu_textarea{width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 8px}',
      '.__tu_input{font-variant-numeric:tabular-nums}',
      '.__tu_input--number{text-align:right}',
      '.__tu_textarea{min-height:64px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5}',
      '.__tu_input:focus-visible,.__tu_textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:transparent}',
      '.__tu_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 10px}',
      '.__tu_group{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);padding:10px 12px}',
      '.__tu_groupTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.__tu_tierBody{display:flex;flex-direction:column;gap:10px}',
      '.__tu_checks{display:flex;flex-wrap:wrap;gap:8px 18px}',
      '.__tu_check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.__tu_check input{accent-color:var(--dsw-alias-brand-primary);margin:0}',
      '.__tu_modelList{display:flex;flex-direction:column;gap:8px}',
      '.__tu_modelCard{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.__tu_modelHead{display:flex;align-items:center;gap:8px;width:100%;border:0;border-radius:10px;background:none;color:inherit;font:inherit;text-align:left;padding:9px 12px;cursor:pointer}',
      '.__tu_modelHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.__tu_chevron{display:inline-block;width:12px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.__tu_modelHead .__tu_modelName{flex:0 1 auto}',
      '.__tu_modelBody{display:flex;flex-direction:column;gap:12px;padding:0 12px 12px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}',
      '.__tu_balanceList{display:flex;flex-direction:column;gap:8px}',
      '.__tu_balanceRow{display:grid;grid-template-columns:minmax(120px,1fr) minmax(150px,220px) auto;align-items:end;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px}',
      '.__tu_balanceHeading{display:flex;flex-direction:column;gap:1px}',
      '.__tu_emptyState{display:flex;align-items:center;justify-content:center;gap:8px;padding:32px 16px;font-size:13px;color:var(--dsw-alias-label-tertiary)}',
      '.__tu_spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:__tu_spin .8s linear infinite}',
      '.__tu_walletIcon{display:block}',
      '.__tu_srOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '.__tu_root :is(button,input,textarea):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '@keyframes __tu_spin{to{transform:rotate(360deg)}}',
      '@media (max-width:560px){.__tu_period{grid-template-columns:minmax(80px,100px) minmax(0,1fr)}.__tu_period .__tu_tokens{grid-column:1/-1}.__tu_balanceRow{grid-template-columns:minmax(0,1fr)}}',
      '@media (prefers-reduced-motion:reduce){.__tu_spinner{animation:none}.__tu_chartBar{transition:none}}',
      '.__tu_footBtn{appearance:none;display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;min-height:36px;padding:6px 10px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:22px;white-space:nowrap;cursor:pointer;flex:none}',
      '@media (hover:hover){.__tu_footBtn:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}',
      '.__tu_footBtn[data-active="true"]{background-color:var(--dsw-alias-interactive-bg-hover)}',
      '.__tu_footBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.__tu_footBtn--rail{width:36px;height:36px;justify-content:center;padding:0}',
      '.__tu_footLabel{font-weight:500}',
      '.__tu_footAmount{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;max-width:118px;overflow:hidden;text-overflow:ellipsis}'
    ].join('\n');

    (function installStyle() {
      if (typeof document === 'undefined') return;
      var tagId = 'dsh-token-usage/main.css';
      var selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']';
      if (typeof document.querySelector === 'function' && document.querySelector(selector) !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-token-usage';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      if (document.head && typeof document.head.appendChild === 'function') document.head.appendChild(tag);
    })();

    /* ── Locale dictionaries ────────────────────────────────────────────── */

    var zh = {
      panel: '余额',
      title: '余额',
      refresh: '刷新',
      retry: '重试',
      loading: '加载中…',
      saving: '保存中…',
      refreshing: '刷新中…',
      loadFailed: '加载失败',
      errorPrefix: '请求失败',
      updatedAt: '更新于',
      incomplete: '部分会话读取失败，统计可能不完整。',
      unitTokens: 'tokens',
      sessionNone: '当前没有打开的会话；本会话统计为空，余额与历史统计仍可用。',
      providerList: '全部提供商',
      noProviders: '暂无提供商记录。',
      balanceSection: '余额',
      balanceRemaining: '剩余',
      balanceAmount: '已存金额',
      balanceNotSet: '未设置',
      balanceEditable: '可编辑',
      balanceEditorTitle: '余额设置',
      balanceEditLabel: '余额金额',
      balanceHint: '留空并保存表示清除余额。保存时以该提供商当前累计费用为基准，之后的调用会从余额中扣除。',
      balanceSave: '保存余额',
      balanceSaved: '余额已保存',
      balanceInvalid: '请输入有效的数字金额。',
      balanceNone: '没有可编辑的余额记录。',
      unsaved: '未保存',
      statsSection: '统计',
      statsCurrency: '费用单位',
      periodGroup: '统计口径',
      periodSession: '本会话',
      periodToday: '今天',
      periodWeek: '近 7 天',
      periodMonth: '近 30 天',
      periodAll: '历史累计',
      calls: '调用',
      cost: '费用',
      tableTitle: '按模型',
      tableModel: '模型',
      noModels: '该口径暂无模型调用记录。',
      chartTitle: '近 14 天费用',
      noDaily: '暂无近 14 天记录。',
      priceSection: '价格',
      priceCurrency: '货币',
      priceCurrencyHint: '仅用于显示，可填 CNY、USD 或货币符号。',
      priceBase: '基础单价（每百万 tokens）',
      priceValley: '谷时单价（每百万 tokens）',
      priceLong: '长上下文单价（每百万 tokens）',
      priceInput: '输入',
      priceOutput: '输出',
      priceCacheRead: '缓存读',
      priceCacheWrite: '缓存写',
      priceEnableValley: '启用谷时价格',
      priceEnableLong: '启用长上下文价格',
      priceStart: '谷时开始',
      priceEnd: '谷时结束',
      priceWeekends: '周末全天',
      priceHolidays: '节假日全天',
      priceHolidaysList: '节假日日期',
      priceHolidaysHint: '每行或逗号分隔，格式 YYYY-MM-DD。',
      priceThreshold: '长上下文阈值（tokens）',
      priceThresholdHint: '提示词 token 超过该值时使用长上下文价格；设为 0 表示不启用。',
      pricePriced: '已定价',
      priceUnpriced: '未定价',
      priceSave: '保存价格',
      priceSaved: '价格已保存',
      priceNone: '尚未观察到模型调用；发起一次模型调用后即可在这里配置单价。',
      tokenInput: '输入',
      tokenOutput: '输出',
      tokenCacheRead: '缓存读',
      tokenCacheWrite: '缓存写',
      tokenReasoning: '推理',
      tokenTotal: '合计',
      cacheHit: '缓存命中率',
      close: '关闭',
      unpricedHint: '未定价模型，费用可能不完整'
    };

    var en = {
      panel: 'Balance',
      title: 'Balance',
      refresh: 'Refresh',
      retry: 'Retry',
      loading: 'Loading…',
      saving: 'Saving…',
      refreshing: 'Refreshing…',
      loadFailed: 'Failed to load',
      errorPrefix: 'Request failed',
      updatedAt: 'Updated',
      incomplete: 'Some sessions could not be read; totals may be incomplete.',
      unitTokens: 'tokens',
      sessionNone: 'No session is open. Session stats are empty, but balances and history remain available.',
      providerList: 'All providers',
      noProviders: 'No providers recorded yet.',
      balanceSection: 'Balance',
      balanceRemaining: 'Remaining',
      balanceAmount: 'Stored amount',
      balanceNotSet: 'Not set',
      balanceEditable: 'Editable',
      balanceEditorTitle: 'Balance settings',
      balanceEditLabel: 'Balance amount',
      balanceHint: 'Save an empty value to clear the balance. Saving anchors the provider current all-time cost, so later calls are deducted from the balance.',
      balanceSave: 'Save balance',
      balanceSaved: 'Balance saved',
      balanceInvalid: 'Enter a valid numeric amount.',
      balanceNone: 'No editable balance records.',
      unsaved: 'Unsaved',
      statsSection: 'Usage',
      statsCurrency: 'Currency',
      periodGroup: 'Stat periods',
      periodSession: 'This session',
      periodToday: 'Today',
      periodWeek: 'Last 7 days',
      periodMonth: 'Last 30 days',
      periodAll: 'All time',
      calls: 'Calls',
      cost: 'Cost',
      tableTitle: 'By model',
      tableModel: 'Model',
      noModels: 'No model calls in this period.',
      chartTitle: 'Cost over the last 14 days',
      noDaily: 'No daily records yet.',
      priceSection: 'Prices',
      priceCurrency: 'Currency',
      priceCurrencyHint: 'Display only; CNY, USD, or a currency symbol.',
      priceBase: 'Base price (per million tokens)',
      priceValley: 'Valley price (per million tokens)',
      priceLong: 'Long-context price (per million tokens)',
      priceInput: 'Input',
      priceOutput: 'Output',
      priceCacheRead: 'Cache read',
      priceCacheWrite: 'Cache write',
      priceEnableValley: 'Enable valley prices',
      priceEnableLong: 'Enable long-context prices',
      priceStart: 'Valley start',
      priceEnd: 'Valley end',
      priceWeekends: 'Weekends',
      priceHolidays: 'Holidays',
      priceHolidaysList: 'Holiday dates',
      priceHolidaysHint: 'One per line or comma separated, format YYYY-MM-DD.',
      priceThreshold: 'Long-context threshold (tokens)',
      priceThresholdHint: 'Long-context prices apply when prompt tokens exceed this value; set 0 to disable the tier.',
      pricePriced: 'Priced',
      priceUnpriced: 'Not priced',
      priceSave: 'Save prices',
      priceSaved: 'Prices saved',
      priceNone: 'No model usage observed yet. Unit prices can be configured after the first model call.',
      tokenInput: 'Input',
      tokenOutput: 'Output',
      tokenCacheRead: 'Cache read',
      tokenCacheWrite: 'Cache write',
      tokenReasoning: 'Reasoning',
      tokenTotal: 'Total',
      cacheHit: 'Cache hit rate',
      close: 'Close',
      unpricedHint: 'Unpriced model; cost may be incomplete'
    };

    /* ── Small utilities ────────────────────────────────────────────────── */

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function num(value) {
      var n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : 0;
    }

    function formatMoney(value) {
      return moneyFormatter.format(num(value));
    }

    function formatTokens(value) {
      return numberFormatter.format(Math.round(num(value)));
    }

    function formatCurrency(currency, value) {
      var label = typeof currency === 'string' ? currency.trim() : '';
      var text = formatMoney(value);
      if (label === '') return text;
      return CURRENCY_CODE.test(label) ? label + ' ' + text : label + text;
    }

    /** Share of all prompt tokens served from cache (input + cache read + cache write). */
    function cacheHitRate(tokens) {
      var prompt = num(tokens.input) + num(tokens.cacheRead) + num(tokens.cacheWrite);
      return prompt > 0 ? num(tokens.cacheRead) / prompt : null;
    }

    function formatHitRate(tokens) {
      var rate = cacheHitRate(tokens);
      return rate === null ? '—' : (rate * 100).toFixed(1) + '%';
    }

    function formatTimestamp(value) {
      var ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) return '';
      try {
        return timestampFormatter.format(new Date(ms));
      } catch (error) {
        return '';
      }
    }

    function normalizeCurrency(value) {
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_CURRENCY;
    }

    function normalizeClock(value) {
      return typeof value === 'string' && CLOCK_PATTERN.test(value.trim()) ? value.trim() : '';
    }

    function normalizeTokens(source) {
      var raw = isRecord(source) ? source : {};
      var total = Number(raw.total);
      if (!Number.isFinite(total)) {
        total = num(raw.input) + num(raw.output) + num(raw.cacheRead) + num(raw.cacheWrite);
      }
      return {
        input: num(raw.input),
        output: num(raw.output),
        cacheRead: num(raw.cacheRead),
        cacheWrite: num(raw.cacheWrite),
        reasoning: num(raw.reasoning),
        total: total
      };
    }

    function providerOf(id) {
      if (typeof id !== 'string') return '';
      var index = id.indexOf('/');
      return index > 0 ? id.slice(0, index) : id;
    }

    function modelOf(id) {
      if (typeof id !== 'string') return '';
      var index = id.indexOf('/');
      return index >= 0 ? id.slice(index + 1) : id;
    }

    function sessionIdOf(state) {
      if (!isRecord(state) || !isRecord(state.byId)) return null;
      var sessions = Object.values(state.byId);
      for (var i = 0; i < sessions.length; i++) {
        var session = sessions[i];
        var mainView = isRecord(session) && isRecord(session.retainedBy) ? session.retainedBy.mainView : 0;
        if ((mainView === undefined ? 0 : mainView) > 0) {
          return session.id === undefined ? null : session.id;
        }
      }
      return null;
    }

    /** Resolve one Host route against the page directory, keeping proxy prefixes. */
    function apiUrl() {
      var base = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '' ? document.baseURI : 'http://dsh.internal/';
      var directory;
      try {
        var parsed = new URL(base);
        parsed.search = '';
        parsed.hash = '';
        if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
        directory = parsed.href;
      } catch (error) {
        directory = 'http://dsh.internal/';
      }
      return new URL(API_PATH, directory);
    }

    /**
     * One fenced POST to the Host route.
     * @returns {Promise<any>} the envelope's `value`.
     */
    function request(action, payload) {
      return fetch(apiUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: action, payload: payload && typeof payload === 'object' ? payload : {} })
      }).then(function (response) {
        return response.text().then(function (text) {
          var body = null;
          if (text !== '') {
            try {
              body = JSON.parse(text);
            } catch (error) {
              body = null;
            }
          }
          if (body && body.ok === true) return body.value;
          var message = body && isRecord(body.error) && typeof body.error.message === 'string' && body.error.message !== '' ? body.error.message : 'HTTP ' + response.status;
          var failure = new Error(message);
          failure.code = body && isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : 'http-' + response.status;
          throw failure;
        });
      });
    }

    function errorMessage(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message;
      return String(error);
    }

    /* ── Derived overview shapes ────────────────────────────────────────── */

    function normalizePeriod(overview, periodId) {
      var periods = isRecord(overview) && isRecord(overview.periods) ? overview.periods : {};
      var raw = isRecord(periods[periodId]) ? periods[periodId] : {};
      var models = Array.isArray(raw.models) ? raw.models.filter(isRecord) : [];
      return {
        calls: num(raw.calls),
        cost: num(raw.cost),
        tokens: normalizeTokens(raw.tokens),
        models: models
      };
    }

    function observedModelRows(overview) {
      var models = isRecord(overview) && Array.isArray(overview.models) ? overview.models : [];
      var rows = [];
      for (var i = 0; i < models.length; i++) {
        var entry = models[i];
        if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '') continue;
        rows.push({
          id: entry.id,
          provider: typeof entry.provider === 'string' && entry.provider !== '' ? entry.provider : providerOf(entry.id),
          model: typeof entry.model === 'string' && entry.model !== '' ? entry.model : modelOf(entry.id)
        });
      }
      return rows;
    }

    function balanceCardRows(overview) {
      var rows = isRecord(overview) && Array.isArray(overview.balances) ? overview.balances.filter(isRecord) : [];
      return rows.filter(function (row) {
        return typeof row.provider === 'string' && row.provider !== '' && (row.hasBalance === true || row.editable === true);
      });
    }

    function editableBalanceRows(overview) {
      var rows = isRecord(overview) && Array.isArray(overview.balances) ? overview.balances.filter(isRecord) : [];
      var editable = rows.filter(function (row) {
        return typeof row.provider === 'string' && row.provider !== '' && row.editable === true;
      });
      if (editable.length > 0) return editable;
      return rows.filter(function (row) {
        return typeof row.provider === 'string' && row.provider !== '';
      });
    }

    function unpricedIndex(overview) {
      var list = isRecord(overview) && Array.isArray(overview.unpriced) ? overview.unpriced : [];
      var index = {};
      for (var i = 0; i < list.length; i++) if (typeof list[i] === 'string') index[list[i]] = true;
      return index;
    }

    /** Whether any model row of one period contains an unpriced model. */
    function periodHasUnpriced(period, unpriced) {
      for (var i = 0; i < period.models.length; i++) {
        var row = period.models[i];
        if (row && typeof row.id === 'string' && unpriced[row.id] === true) return true;
      }
      return false;
    }

    /* ── Price editor draft shapes ─────────────────────────────────────── */

    function zeroPriceStrings() {
      return { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' };
    }

    function priceStrings(source) {
      var raw = isRecord(source) ? source : {};
      var out = {};
      for (var i = 0; i < PRICE_FIELDS.length; i++) {
        var key = PRICE_FIELDS[i].key;
        out[key] = String(num(raw[key]));
      }
      return out;
    }

    function blankRuleDraft() {
      return {
        base: zeroPriceStrings(),
        valley: zeroPriceStrings(),
        long: zeroPriceStrings(),
        valleyEnabled: false,
        longEnabled: false,
        valleyStart: DEFAULT_VALLEY_START,
        valleyEnd: DEFAULT_VALLEY_END,
        weekends: false,
        holidays: false,
        holidaysText: '',
        threshold: String(DEFAULT_LONG_CONTEXT_THRESHOLD)
      };
    }

    function ruleDraftFrom(source) {
      var rule = isRecord(source) ? source : {};
      var window = isRecord(rule.valleyWindow) ? rule.valleyWindow : {};
      var start = normalizeClock(window.start);
      var end = normalizeClock(window.end);
      var holidays = Array.isArray(rule.holidays) ? rule.holidays.filter(function (day) {
        return typeof day === 'string' && DAY_PATTERN.test(day);
      }) : [];
      var threshold = Number(rule.longContextThreshold);
      return {
        base: priceStrings(rule.base),
        valley: priceStrings(rule.valley),
        long: priceStrings(rule.long),
        valleyEnabled: isRecord(rule.valley),
        longEnabled: isRecord(rule.long),
        valleyStart: start === '' ? DEFAULT_VALLEY_START : start,
        valleyEnd: end === '' ? DEFAULT_VALLEY_END : end,
        weekends: window.weekends === true,
        holidays: window.holidays === true,
        holidaysText: holidays.join('\n'),
        threshold: Number.isFinite(threshold) && threshold >= 0 ? String(Math.round(threshold)) : String(DEFAULT_LONG_CONTEXT_THRESHOLD)
      };
    }

    function priceDraftFromNumber(number) {
      return Number.isFinite(number) && number > 0 ? number : 0;
    }

    /** "Empty means 0" for all four price inputs. */
    function priceStringsToNumbers(prices) {
      var raw = isRecord(prices) ? prices : {};
      var out = {};
      for (var i = 0; i < PRICE_FIELDS.length; i++) {
        var key = PRICE_FIELDS[i].key;
        out[key] = priceDraftFromNumber(Number(String(raw[key] === undefined ? '' : raw[key]).trim()));
      }
      return out;
    }

    function parseHolidayText(text) {
      var parts = String(text === undefined || text === null ? '' : text).split(/[\s,;]+/);
      var seen = {};
      var days = [];
      for (var i = 0; i < parts.length; i++) {
        var day = parts[i].trim();
        if (!DAY_PATTERN.test(day) || seen[day] === true) continue;
        seen[day] = true;
        days.push(day);
      }
      days.sort();
      return days;
    }

    function serializeRuleDraft(draft) {
      var rule = isRecord(draft) ? draft : blankRuleDraft();
      var thresholdText = String(rule.threshold === undefined || rule.threshold === null ? '' : rule.threshold).trim();
      var thresholdNumber = Number(thresholdText);
      var threshold = thresholdText === '' || !Number.isFinite(thresholdNumber) || thresholdNumber < 0 ? DEFAULT_LONG_CONTEXT_THRESHOLD : Math.round(thresholdNumber);
      var start = normalizeClock(rule.valleyStart);
      var end = normalizeClock(rule.valleyEnd);
      return {
        base: priceStringsToNumbers(rule.base),
        valley: rule.valleyEnabled === true ? priceStringsToNumbers(rule.valley) : null,
        long: rule.longEnabled === true ? priceStringsToNumbers(rule.long) : null,
        valleyWindow: {
          start: start === '' ? DEFAULT_VALLEY_START : start,
          end: end === '' ? DEFAULT_VALLEY_END : end,
          weekends: rule.weekends === true,
          holidays: rule.holidays === true
        },
        holidays: parseHolidayText(rule.holidaysText),
        longContextThreshold: threshold
      };
    }

    /** The editable subset: currency plus the observed models only. */
    function serializeVisibleConfig(draft) {
      var source = isRecord(draft) ? draft : {};
      var models = isRecord(source.models) ? source.models : {};
      var out = {};
      var ids = Object.keys(models).sort();
      for (var i = 0; i < ids.length; i++) out[ids[i]] = serializeRuleDraft(models[ids[i]]);
      return { currency: normalizeCurrency(source.currency), models: out };
    }

    /** The full saveConfig payload, preserving configured models not in view. */
    function serializeSaveConfig(overview, draft) {
      var visible = serializeVisibleConfig(draft);
      var config = isRecord(overview) && isRecord(overview.config) ? overview.config : {};
      var configured = isRecord(config.models) ? config.models : {};
      var models = {};
      var ids = Object.keys(configured);
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (!Object.prototype.hasOwnProperty.call(visible.models, id)) models[id] = configured[id];
      }
      var visibleIds = Object.keys(visible.models);
      for (var j = 0; j < visibleIds.length; j++) models[visibleIds[j]] = visible.models[visibleIds[j]];
      return {
        version: typeof config.version === 'number' ? config.version : 1,
        currency: visible.currency,
        models: models,
        balances: isRecord(config.balances) ? config.balances : {}
      };
    }

    function configDraftFrom(overview, rows) {
      var config = isRecord(overview) && isRecord(overview.config) ? overview.config : {};
      var models = isRecord(config.models) ? config.models : {};
      var draft = { currency: normalizeCurrency(config.currency), models: {} };
      for (var i = 0; i < rows.length; i++) draft.models[rows[i].id] = ruleDraftFrom(models[rows[i].id]);
      return draft;
    }

    /** Overlay a user edit on the latest server draft, keeping newly observed models. */
    function mergeConfigDrafts(serverDraft, edit) {
      if (!isRecord(edit)) return serverDraft;
      var models = {};
      var baseModels = isRecord(serverDraft) && isRecord(serverDraft.models) ? serverDraft.models : {};
      var editModels = isRecord(edit.models) ? edit.models : {};
      var ids = Object.keys(baseModels);
      for (var i = 0; i < ids.length; i++) models[ids[i]] = baseModels[ids[i]];
      ids = Object.keys(editModels);
      for (var j = 0; j < ids.length; j++) models[ids[j]] = editModels[ids[j]];
      return {
        currency: edit.currency === undefined ? serverDraft.currency : edit.currency,
        models: models
      };
    }

    /** A model counts as priced when any enabled tier has a positive price (matches the Host). */
    function isRuleDraftPriced(draft) {
      if (!isRecord(draft)) return false;
      var tiers = ['base'];
      if (draft.valleyEnabled === true) tiers.push('valley');
      if (draft.longEnabled === true) tiers.push('long');
      for (var t = 0; t < tiers.length; t++) {
        var prices = isRecord(draft[tiers[t]]) ? draft[tiers[t]] : {};
        for (var i = 0; i < PRICE_FIELDS.length; i++) {
          if (num(prices[PRICE_FIELDS[i].key]) > 0) return true;
        }
      }
      return false;
    }

    /* ── Balance editor draft shapes ───────────────────────────────────── */

    function balanceServerDraft(overview) {
      var rows = editableBalanceRows(overview);
      var out = {};
      for (var i = 0; i < rows.length; i++) {
        var amount = rows[i].amount;
        out[rows[i].provider] = amount === null || amount === undefined ? '' : String(amount);
      }
      return out;
    }

    function parseAmountInput(value) {
      var trimmed = String(value === undefined || value === null ? '' : value).trim();
      if (trimmed === '') return { valid: true, value: null };
      var numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return { valid: false, value: null };
      return { valid: true, value: numeric };
    }

    function amountKey(value) {
      var parsed = parseAmountInput(value);
      if (!parsed.valid) return 'invalid';
      return parsed.value === null ? '' : String(parsed.value);
    }

    function mergeBalanceDraft(serverDraft, edit) {
      var merged = {};
      var provider;
      for (provider in serverDraft) {
        if (Object.prototype.hasOwnProperty.call(serverDraft, provider)) merged[provider] = serverDraft[provider];
      }
      if (isRecord(edit)) {
        for (provider in edit) {
          if (Object.prototype.hasOwnProperty.call(edit, provider) && Object.prototype.hasOwnProperty.call(merged, provider)) merged[provider] = edit[provider];
        }
      }
      return merged;
    }

    function dirtyBalanceProviders(merged, serverDraft) {
      var dirty = [];
      var providers = Object.keys(merged).sort();
      for (var i = 0; i < providers.length; i++) {
        if (amountKey(merged[providers[i]]) !== amountKey(serverDraft[providers[i]])) dirty.push(providers[i]);
      }
      return dirty;
    }

    function sparseSignature(map) {
      var keys = Object.keys(map).sort();
      return keys.map(function (key) {
        return key + '=' + String(map[key]);
      }).join('\u0000');
    }

    /* ── Render helpers ────────────────────────────────────────────────── */

    function flattenInto(list, out) {
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (Array.isArray(item)) flattenInto(item, out);
        else out.push(item);
      }
      return out;
    }

    /** createElement with children spread so static child arrays never warn. */
    function element(type, props, children) {
      var args = [type, props];
      var flat = flattenInto(Array.isArray(children) ? children : [children], []);
      for (var i = 0; i < flat.length; i++) {
        if (flat[i] === null || flat[i] === undefined) continue;
        args.push(flat[i]);
      }
      return h.apply(null, args);
    }

    function Section(props) {
      return element('section', { className: '__tu_section' }, [
        props.title ? h('h2', { className: '__tu_sectionTitle' }, props.title) : null,
        props.children
      ]);
    }

    function WalletIcon(props) {
      var size = props && Number.isFinite(Number(props.size)) && Number(props.size) > 0 ? Number(props.size) : 16;
      var active = Boolean(props && props.active === true);
      var attrs = {
        width: size,
        height: size,
        viewBox: '0 0 64 64',
        focusable: 'false',
        'aria-hidden': 'true',
        className: '__tu_walletIcon'
      };
      return h('svg', attrs,
        h('g', {
          transform: 'scale(2.6667)',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        },
          h('path', { d: 'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1' }),
          h('path', { d: 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4' })
        )      );
    }

    /** Display name of one balance row, falling back to the provider id. */
    function balanceProviderName(row) {
      if (!isRecord(row)) return '';
      return typeof row.name === 'string' && row.name !== '' ? row.name : String(row.provider === undefined ? '' : row.provider);
    }

    /** Rows the sidebar-foot chip summarizes: providers with a saved balance. */
    /** Provider the current Session runs, when the Host can tell. */
    function sessionProviderOf(overview) {
      return isRecord(overview) && typeof overview.sessionProvider === 'string' ? overview.sessionProvider : '';
    }

    /** Display name of a provider id from the overview catalog. */
    function providerNameOf(overview, provider) {
      if (typeof provider !== 'string' || provider === '') return '';
      var list = isRecord(overview) && Array.isArray(overview.providers) ? overview.providers : [];
      for (var i = 0; i < list.length; i += 1) {
        if (isRecord(list[i]) && list[i].id === provider) {
          var name = typeof list[i].name === 'string' ? list[i].name : '';
          return name !== '' ? name : provider;
        }
      }
      return provider;
    }

    /**
     * Balance rows the footer chip shows: the current Session's providers first,
     * so switching to a Session on another provider switches the chip with it.
     */
    function balanceFooterRows(overview) {
      var rows = isRecord(overview) && Array.isArray(overview.balances) ? overview.balances.filter(isRecord) : [];
      var withBalance = [];
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].hasBalance === true && Number.isFinite(Number(rows[i].remaining))) withBalance.push(rows[i]);
      }
      var sessionProvider = sessionProviderOf(overview);
      if (sessionProvider === '') return withBalance;
      var sessionProviders = isRecord(overview) && Array.isArray(overview.sessionProviders) ? overview.sessionProviders : [];
      return withBalance.filter(function (row) {
        return row.provider === sessionProvider || sessionProviders.indexOf(row.provider) >= 0;
      });
    }

    /** Tell the sidebar chip (and any other consumer) that stored state changed. */
    function notifyOverviewChanged() {
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('dsh-token-usage:changed'));
        }
      } catch (error) {
        // The change notification is best-effort only.
      }
    }

    /**
     * Sidebar-foot chip: opens the panel and, without opening anything, shows the
     * remaining balance of the providers the current session used.
     */
    function FooterBalance(props) {
      var t = typeof props.t === 'function' ? props.t : function (key) { return key; };
      var wide = props.wide === true;
      var useSessions = props.useSessions;
      var usePanelInfo = props.usePanelInfo;
      var sessionId = typeof useSessions === 'function' ? useSessions(sessionIdOf) : null;
      var active = typeof usePanelInfo === 'function'
        ? usePanelInfo(function (info) { return isRecord(info) && info.activePanelId === PANEL_ID; })
        : false;
      var overviewState = React.useState(null);
      var overview = overviewState[0];
      var setOverview = overviewState[1];
      var mountedRef = React.useRef(true);
      var sequenceRef = React.useRef(0);
      var sessionIdRef = React.useRef(sessionId);
      sessionIdRef.current = sessionId;

      var load = React.useCallback(function loadFooter() {
        var sequence = sequenceRef.current + 1;
        sequenceRef.current = sequence;
        var requested = sessionIdRef.current === undefined || sessionIdRef.current === null ? null : String(sessionIdRef.current);
        return request('overview', { sessionId: requested }).then(function (value) {
          if (!mountedRef.current || sequence !== sequenceRef.current) return;
          setOverview(isRecord(value) ? value : {});
        }, function () {
          // The chip is a convenience; the panel owns error reporting.
        });
      }, []);

      React.useEffect(function () {
        mountedRef.current = true;
        void load();
        var timer = typeof window !== 'undefined' && typeof window.setInterval === 'function'
          ? window.setInterval(function () { void load(); }, REFRESH_INTERVAL_MS)
          : null;
        var onChanged = function () { void load(); };
        var onVisibility = function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') void load();
        };
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('dsh-token-usage:changed', onChanged);
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onVisibility);
        return function () {
          mountedRef.current = false;
          sequenceRef.current += 1;
          if (timer !== null && typeof window !== 'undefined' && typeof window.clearInterval === 'function') window.clearInterval(timer);
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('dsh-token-usage:changed', onChanged);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [load]);

      React.useEffect(function () {
        void load();
      }, [sessionId, load]);

      var rows = balanceFooterRows(overview);
      var sessionProvider = sessionProviderOf(overview);
      var amount = '';
      var title = t('panel');
      if (rows.length > 0) {
        var firstName = balanceProviderName(rows[0]);
        amount = firstName + ' ' + compactMoneyFormatter.format(num(rows[0].remaining));
        if (rows.length > 1) amount += ' +' + (rows.length - 1);
        title = t('panel') + ' · ' + rows.map(function (row) {
          return balanceProviderName(row) + ' ' + compactMoneyFormatter.format(num(row.remaining));
        }).join(' · ');
      } else if (sessionProvider !== '') {
        amount = providerNameOf(overview, sessionProvider) + ' ' + t('balanceNotSet');
        title = t('panel') + ' · ' + amount;
      }

      return h('button', {
        type: 'button',
        className: '__tu_footBtn' + (wide ? '' : ' __tu_footBtn--rail'),
        'data-active': active ? 'true' : undefined,
        title: title,
        'aria-label': title,
        'aria-current': active ? 'page' : undefined,
        onClick: function () {
          if (typeof props.onOpen === 'function') props.onOpen();
        }
      },
        h(WalletIcon, { size: wide ? 16 : 18, active: active }),
        wide ? h('span', { className: '__tu_footLabel' }, t('panel')) : null,
        wide && amount !== '' ? h('span', { className: '__tu_footAmount' }, amount) : null
      );
    }
    function TokenBreakdown(props) {
      var tokens = normalizeTokens(props.tokens);
      var fields = TOKEN_FIELDS.map(function (field) {
        return h('span', { className: '__tu_token', key: field.key },
          h('span', null, props.t(field.label)),
          h('b', null, formatTokens(tokens[field.key])));
      });
      fields.push(h('span', { className: '__tu_token __tu_hitRate', key: 'cacheHit' },
        h('span', null, props.t('cacheHit')),
        h('b', null, formatHitRate(tokens))));
      return h('div', { className: '__tu_tokens' }, fields);
    }

    function CostValue(props) {
      return h('span', { className: '__tu_cost', title: props.marked ? props.t('unpricedHint') : undefined },
        formatMoney(props.value),
        props.marked ? h('span', { className: '__tu_star', 'aria-hidden': 'true' }, '*') : null,
        props.marked ? h('span', { className: '__tu_srOnly' }, props.t('unpricedHint')) : null);
    }

    function BalanceSection(props) {
      var t = props.t;
      var overview = isRecord(props.overview) ? props.overview : {};
      var rows = balanceCardRows(overview);
      var noSession = overview.sessionId === null || overview.sessionId === undefined;
      var providers = Array.isArray(overview.providers) ? overview.providers.filter(isRecord) : [];
      var providerNames = providers.map(function (provider) {
        return typeof provider.name === 'string' && provider.name !== '' ? provider.name : providerOf(provider.id);
      }).filter(function (name) {
        return name !== '';
      }).join(', ');

      var body;
      if (rows.length > 0) {
        body = h('div', { className: '__tu_cards' }, rows.map(function (row) {
          var hasBalance = row.hasBalance === true;
          var remaining = num(row.remaining);
          var negative = hasBalance && remaining < 0;
          return h('div', { className: '__tu_card', key: row.provider },
            h('div', { className: '__tu_cardName' },
              h('span', null, typeof row.name === 'string' && row.name !== '' ? row.name : row.provider),
              row.editable === true ? h('span', { className: '__tu_tag' }, t('balanceEditable')) : null),
            h('div', { className: '__tu_amount' + (negative ? ' __tu_amount--negative' : '') },
              hasBalance ? formatMoney(remaining) : h('span', { className: '__tu_muted __tu_amountEmpty' }, t('balanceNotSet'))),
            h('div', { className: '__tu_muted' }, hasBalance ? t('balanceAmount') + ': ' + formatMoney(row.amount) : t('balanceRemaining') + ': —'),
            h('div', { className: '__tu_providerId' }, row.provider));
        }));
      } else if (providerNames !== '') {
        body = h('p', { className: '__tu_hint' }, t('providerList') + ': ' + providerNames);
      } else {
        body = h('p', { className: '__tu_hint' }, t('noProviders'));
      }

      return h(Section, { title: t('balanceSection') },
        noSession ? h('p', { className: '__tu_hint' }, t('sessionNone')) : null,
        body);
    }

    function ModelTable(props) {
      var t = props.t;
      var rows = props.rows;
      var unpriced = props.unpriced;
      if (rows.length === 0) return h('p', { className: '__tu_hint' }, t('noModels'));
      var headers = [
        t('tableModel'),
        t('calls'),
        t('cost'),
        t('tokenInput'),
        t('tokenOutput'),
        t('tokenCacheRead'),
        t('tokenCacheWrite'),
        t('tokenReasoning'),
        t('tokenTotal'),
        t('cacheHit')
      ].map(function (label, index) {
        return h('th', { key: 'h' + index, scope: 'col' }, label);
      });
      var body = rows.map(function (row, index) {
        var tokens = normalizeTokens(row.tokens);
        var marked = typeof row.id === 'string' && unpriced[row.id] === true;
        return h('tr', { key: (typeof row.id === 'string' ? row.id : 'row') + ':' + index },
          h('td', null,
            h('div', { className: '__tu_modelCell' },
              h('span', { className: '__tu_modelName', title: typeof row.id === 'string' ? row.id : undefined }, typeof row.model === 'string' && row.model !== '' ? row.model : modelOf(row.id)),
              h('span', { className: '__tu_providerId' }, typeof row.provider === 'string' && row.provider !== '' ? row.provider : providerOf(row.id)))),
          h('td', null, formatTokens(row.calls)),
          h('td', null, h(CostValue, { t: t, value: row.cost, marked: marked })),
          h('td', null, formatTokens(tokens.input)),
          h('td', null, formatTokens(tokens.output)),
          h('td', null, formatTokens(tokens.cacheRead)),
          h('td', null, formatTokens(tokens.cacheWrite)),
          h('td', null, formatTokens(tokens.reasoning)),
          h('td', null, formatTokens(tokens.total)),
          h('td', null, formatHitRate(tokens)));
      });
      return h('div', { className: '__tu_tableWrap' },
        h('table', { className: '__tu_table' },
          h('thead', null, h('tr', null, headers)),
          h('tbody', null, body)));
    }

    function DailyChart(props) {
      var t = props.t;
      var days = Array.isArray(props.days) ? props.days.filter(isRecord) : [];
      if (days.length === 0) return h('p', { className: '__tu_hint' }, t('noDaily'));
      var currency = normalizeCurrency(props.currency);
      var max = 0;
      for (var i = 0; i < days.length; i++) {
        var value = num(days[i].cost);
        if (value > max) max = value;
      }
      var hoverState = React.useState(-1);
      var hovered = hoverState[0];
      var setHovered = hoverState[1];
      var bars = days.map(function (day, index) {
        var cost = num(day.cost);
        var tokens = normalizeTokens(day.tokens);
        var ratio = max > 0 && cost > 0 ? Math.max(cost / max, 0.03) : 0;
        var dayKey = typeof day.day === 'string' && day.day !== '' ? day.day : 'day-' + index;
        var label = dayKey.length >= 5 ? dayKey.slice(5) : dayKey;
        var active = hovered === index;
        var tipClass = '__tu_tip' + (index === 0 ? ' __tu_tip--first' : '') + (index === days.length - 1 ? ' __tu_tip--last' : '');
        return h('div', {
          className: '__tu_chartDay' + (active ? ' __tu_chartDay--hover' : ''),
          key: dayKey + ':' + index,
          tabIndex: 0,
          'aria-label': dayKey + ' · ' + formatCurrency(currency, cost) + ' · ' + formatTokens(tokens.total) + ' ' + t('unitTokens'),
          onMouseEnter: function () { setHovered(index); },
          onMouseLeave: function () { setHovered(-1); },
          onFocus: function () { setHovered(index); },
          onBlur: function () { setHovered(-1); }
        },
          h('div', { className: '__tu_chartBarArea' },
            h('div', {
              className: '__tu_chartBar' + (cost > 0 ? '' : ' __tu_chartBar--zero'),
              style: { height: (ratio * 100).toFixed(1) + '%' }
            })),
          h('span', { className: '__tu_chartLabel' }, label),
          active ? h('div', { className: tipClass, role: 'tooltip', style: { bottom: Math.min(ratio * 100, 48).toFixed(1) + '%' } },
            h('span', { className: '__tu_tipDay' }, dayKey),
            h('b', { className: '__tu_tipCost' }, formatCurrency(currency, cost)),
            h('span', { className: '__tu_tipTokens' }, formatTokens(tokens.total) + ' ' + t('unitTokens'))) : null);
      });
      return h('div', { className: '__tu_chart', role: 'group', 'aria-label': t('chartTitle') }, bars);
    }

    function StatsSection(props) {
      var t = props.t;
      var overview = isRecord(props.overview) ? props.overview : {};
      var selected = props.selected;
      var unpriced = props.unpriced;
      var currency = normalizeCurrency(overview.currency);
      var selectedPeriod = normalizePeriod(overview, selected);

      var periodRows = PERIODS.map(function (entry) {
        var period = normalizePeriod(overview, entry.id);
        var active = entry.id === selected;
        return h('button', {
          type: 'button',
          key: entry.id,
          className: '__tu_period',
          'aria-pressed': active,
          onClick: function () {
            props.onSelect(entry.id);
          }
        },
        h('span', { className: '__tu_periodName' }, t(entry.label)),
        h('span', { className: '__tu_periodCost' },
          h(CostValue, { t: t, value: period.cost, marked: periodHasUnpriced(period, unpriced) }),
          h('span', { className: '__tu_muted' }, formatTokens(period.calls) + ' ' + t('calls'))),
        h(TokenBreakdown, { t: t, tokens: period.tokens }));
      });

      return element('section', { className: '__tu_section' }, [
        h('h2', { className: '__tu_sectionTitle' }, t('statsSection')),
        h('div', { className: '__tu_periods', role: 'group', 'aria-label': t('periodGroup') }, periodRows),
        h('div', { className: '__tu_subhead' },
          h('h3', { className: '__tu_subtitle' }, t('tableTitle')),
          h('span', { className: '__tu_muted' }, t('statsCurrency') + ': ' + currency)),
        h(ModelTable, { t: t, rows: selectedPeriod.models, unpriced: unpriced }),
        h('div', { className: '__tu_subhead' }, h('h3', { className: '__tu_subtitle' }, t('chartTitle'))),
        h(DailyChart, { t: t, days: overview.daily, currency: currency })
      ]);
    }

    function TextField(props) {
      var attrs = {
        type: 'text',
        className: '__tu_input',
        value: props.value,
        spellCheck: false,
        onChange: function (event) {
          props.onChange(event.target.value);
        }
      };
      if (props.placeholder) attrs.placeholder = props.placeholder;
      return h('label', { className: '__tu_field' },
        h('span', { className: '__tu_fieldLabel' }, props.label),
        h('input', attrs),
        props.hint ? h('span', { className: '__tu_hint' }, props.hint) : null);
    }

    function NumberField(props) {
      var attrs = {
        type: 'number',
        className: '__tu_input __tu_input--number',
        step: props.step || 'any',
        value: props.value,
        inputMode: 'decimal',
        onChange: function (event) {
          props.onChange(event.target.value);
        },
        'aria-label': props.ariaLabel || props.label
      };
      if (props.min !== false) attrs.min = props.min || '0';
      if (props.placeholder) attrs.placeholder = props.placeholder;
      return h('label', { className: '__tu_field' },
        h('span', { className: '__tu_fieldLabel' }, props.label),
        h('input', attrs),
        props.hint ? h('span', { className: '__tu_hint' }, props.hint) : null);
    }

    function TimeField(props) {
      return h('label', { className: '__tu_field' },
        h('span', { className: '__tu_fieldLabel' }, props.label),
        h('input', {
          type: 'time',
          className: '__tu_input',
          value: props.value,
          onChange: function (event) {
            props.onChange(event.target.value);
          }
        }));
    }

    function CheckField(props) {
      return h('label', { className: '__tu_check' },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          onChange: function (event) {
            props.onChange(event.target.checked);
          }
        }),
        h('span', null, props.label));
    }

    function PriceFields(props) {
      return h('div', { className: '__tu_grid' }, PRICE_FIELDS.map(function (field) {
        return h(NumberField, {
          key: props.tier + ':' + field.key,
          label: props.t(field.label),
          value: props.prices[field.key],
          onChange: function (value) {
            props.onChange(field.key, value);
          }
        });
      }));
    }

    function ModelCard(props) {
      var t = props.t;
      var row = props.row;
      var rule = props.rule;
      var priced = isRuleDraftPriced(rule);
      var openState = React.useState(!priced);
      var open = openState[0];
      var setOpen = openState[1];

      function changePrice(tier, key, value) {
        props.onPrice(row.id, tier, key, value);
      }

      var valleyBody = rule.valleyEnabled === true
        ? h('div', { className: '__tu_tierBody' },
            h('div', { className: '__tu_grid' },
              h(TimeField, {
                label: t('priceStart'),
                value: rule.valleyStart,
                onChange: function (value) {
                  props.onRule(row.id, { valleyStart: value });
                }
              }),
              h(TimeField, {
                label: t('priceEnd'),
                value: rule.valleyEnd,
                onChange: function (value) {
                  props.onRule(row.id, { valleyEnd: value });
                }
              })),
            h('div', { className: '__tu_checks' },
              h(CheckField, {
                label: t('priceWeekends'),
                checked: rule.weekends,
                onChange: function (value) {
                  props.onRule(row.id, { weekends: value });
                }
              }),
              h(CheckField, {
                label: t('priceHolidays'),
                checked: rule.holidays,
                onChange: function (value) {
                  props.onRule(row.id, { holidays: value });
                }
              })),
            h('label', { className: '__tu_field' },
              h('span', { className: '__tu_fieldLabel' }, t('priceHolidaysList')),
              h('textarea', {
                className: '__tu_textarea',
                value: rule.holidaysText,
                spellCheck: false,
                placeholder: '2026-10-01',
                onChange: function (event) {
                  props.onRule(row.id, { holidaysText: event.target.value });
                }
              }),
              h('span', { className: '__tu_hint' }, t('priceHolidaysHint'))),
            h(PriceFields, {
              t: t,
              tier: 'valley',
              prices: rule.valley,
              onChange: function (key, value) {
                changePrice('valley', key, value);
              }
            }))
        : null;

      var longBody = rule.longEnabled === true
        ? h('div', { className: '__tu_tierBody' },
            h(NumberField, {
              label: t('priceThreshold'),
              value: rule.threshold,
              step: '1',
              hint: t('priceThresholdHint'),
              onChange: function (value) {
                props.onRule(row.id, { threshold: value });
              }
            }),
            h(PriceFields, {
              t: t,
              tier: 'long',
              prices: rule.long,
              onChange: function (key, value) {
                changePrice('long', key, value);
              }
            }))
        : null;

      return h('div', { className: '__tu_modelCard' },
        h('button', {
          type: 'button',
          className: '__tu_modelHead',
          'aria-expanded': open,
          onClick: function () {
            setOpen(!open);
          }
        },
        h('span', { className: '__tu_chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
        h('span', { className: '__tu_modelName', title: row.id }, row.model !== '' ? row.model : row.id),
        h('span', { className: '__tu_providerId' }, row.provider),
        h('span', { className: '__tu_spacer' }),
        h('span', { className: '__tu_tag ' + (priced ? '__tu_tag--ok' : '__tu_tag--warn') }, priced ? t('pricePriced') : t('priceUnpriced'))),
        open ? h('div', { className: '__tu_modelBody' },
          h('div', { className: '__tu_group' },
            h('div', { className: '__tu_groupTitle' }, t('priceBase')),
            h(PriceFields, {
              t: t,
              tier: 'base',
              prices: rule.base,
              onChange: function (key, value) {
                changePrice('base', key, value);
              }
            })),
          h('div', { className: '__tu_group' },
            h('div', { className: '__tu_groupTitle' }, t('priceValley')),
            h(CheckField, {
              label: t('priceEnableValley'),
              checked: rule.valleyEnabled,
              onChange: function (value) {
                props.onRule(row.id, { valleyEnabled: value });
              }
            }),
            valleyBody),
          h('div', { className: '__tu_group' },
            h('div', { className: '__tu_groupTitle' }, t('priceLong')),
            h(CheckField, {
              label: t('priceEnableLong'),
              checked: rule.longEnabled,
              onChange: function (value) {
                props.onRule(row.id, { longEnabled: value });
              }
            }),
            longBody))
          : null);
    }

    function PriceEditor(props) {
      var t = props.t;
      var draft = props.draft;
      var rows = props.rows;
      var modelCards = rows.map(function (row) {
        return h(ModelCard, {
          key: row.id,
          t: t,
          row: row,
          rule: draft.models[row.id] || blankRuleDraft(),
          onRule: props.onRule,
          onPrice: props.onPrice
        });
      });
      return element('section', { className: '__tu_section' }, [
        h('h2', { className: '__tu_sectionTitle' }, t('priceSection')),
        h('div', { className: '__tu_editorHead' },
          h(TextField, {
            label: t('priceCurrency'),
            value: draft.currency,
            hint: t('priceCurrencyHint'),
            onChange: props.onCurrency
          }),
          h('span', { className: '__tu_spacer' }),
          props.saving ? h('span', { className: '__tu_muted' }, t('saving')) : null,
          h('button', {
            type: 'button',
            className: '__tu_button __tu_button--primary',
            disabled: !props.dirty || props.saving,
            onClick: props.onSave
          }, t('priceSave'))),
        rows.length === 0 ? h('p', { className: '__tu_hint' }, t('priceNone')) : h('div', { className: '__tu_modelList' }, modelCards)
      ]);
    }

    function BalanceEditor(props) {
      var t = props.t;
      var rows = props.rows;
      var values = props.values;
      var dirtyMap = {};
      for (var d = 0; d < props.dirty.length; d++) dirtyMap[props.dirty[d]] = true;

      var list = rows.map(function (row) {
        var value = Object.prototype.hasOwnProperty.call(values, row.provider) ? values[row.provider] : '';
        var hasBalance = row.hasBalance === true;
        return h('div', { className: '__tu_balanceRow', key: row.provider },
          h('div', { className: '__tu_balanceHeading' },
            h('span', { className: '__tu_modelName' }, typeof row.name === 'string' && row.name !== '' ? row.name : row.provider),
            h('span', { className: '__tu_providerId' },
              String(row.provider) + (hasBalance ? ' · ' + t('balanceRemaining') + ' ' + formatMoney(row.remaining) : ''))),
          h(NumberField, {
            label: t('balanceEditLabel'),
            ariaLabel: (typeof row.name === 'string' && row.name !== '' ? row.name : row.provider) + ' — ' + t('balanceEditLabel'),
            value: value,
            min: false,
            placeholder: t('balanceNotSet'),
            onChange: function (next) {
              props.onChange(row.provider, next);
            }
          }),
          dirtyMap[row.provider] === true ? h('span', { className: '__tu_tag __tu_tag--warn' }, t('unsaved')) : null);
      });

      return element('section', { className: '__tu_section' }, [
        h('h2', { className: '__tu_sectionTitle' }, t('balanceEditorTitle')),
        h('div', { className: '__tu_editorHead' },
          h('span', { className: '__tu_spacer' }),
          props.saving ? h('span', { className: '__tu_muted' }, t('saving')) : null,
          h('button', {
            type: 'button',
            className: '__tu_button __tu_button--primary',
            disabled: props.dirty.length === 0 || props.saving,
            onClick: props.onSave
          }, t('balanceSave'))),
        rows.length === 0 ? h('p', { className: '__tu_hint' }, t('balanceNone')) : h('div', { className: '__tu_balanceList' }, list),
        h('p', { className: '__tu_hint' }, t('balanceHint'))
      ]);
    }

    /* ── Main panel ────────────────────────────────────────────────────── */

    function TokenUsagePanel(props) {
      var t = typeof props.t === 'function' ? props.t : function (key) {
        return key;
      };
      var useSessions = props.useSessions;
      var sessionId = typeof useSessions === 'function' ? useSessions(sessionIdOf) : null;

      var overviewState = React.useState(null);
      var overview = overviewState[0];
      var setOverview = overviewState[1];
      var pendingState = React.useState(true);
      var pending = pendingState[0];
      var setPending = pendingState[1];
      var errorState = React.useState('');
      var error = errorState[0];
      var setError = errorState[1];
      var periodState = React.useState('session');
      var selectedPeriod = periodState[0];
      var setSelectedPeriod = periodState[1];
      var configEditState = React.useState(null);
      var configEdit = configEditState[0];
      var setConfigEdit = configEditState[1];
      var balanceEditState = React.useState(null);
      var balanceEdit = balanceEditState[0];
      var setBalanceEdit = balanceEditState[1];
      var savingConfigState = React.useState(false);
      var savingConfig = savingConfigState[0];
      var setSavingConfig = savingConfigState[1];
      var savingBalanceState = React.useState(false);
      var savingBalance = savingBalanceState[0];
      var setSavingBalance = savingBalanceState[1];
      var flashState = React.useState(null);
      var flash = flashState[0];
      var setFlash = flashState[1];
      var overviewRecord = isRecord(overview) ? overview : null;

      var mountedRef = React.useRef(true);
      var sequenceRef = React.useRef(0);
      var sessionIdRef = React.useRef(sessionId);
      sessionIdRef.current = sessionId;

      var load = React.useCallback(function loadOverview() {
        var sequence = sequenceRef.current + 1;
        sequenceRef.current = sequence;
        setPending(true);
        var requested = sessionIdRef.current === undefined || sessionIdRef.current === null ? null : String(sessionIdRef.current);
        return request('overview', { sessionId: requested }).then(function (value) {
          if (!mountedRef.current || sequence !== sequenceRef.current) return;
          setOverview(isRecord(value) ? value : {});
          setError('');
          setPending(false);
        }, function (failure) {
          if (!mountedRef.current || sequence !== sequenceRef.current) return;
          setError(errorMessage(failure));
          setPending(false);
        });
      }, []);

      React.useEffect(function () {
        mountedRef.current = true;
        var timer = null;
        if (typeof window !== 'undefined' && window && typeof window.setInterval === 'function') {
          timer = window.setInterval(function () {
            void load();
          }, REFRESH_INTERVAL_MS);
        }
        var onVisibility = function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') void load();
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility);
        }
        return function () {
          mountedRef.current = false;
          sequenceRef.current += 1;
          if (timer !== null && typeof window !== 'undefined' && typeof window.clearInterval === 'function') window.clearInterval(timer);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }, [load]);

      React.useEffect(function () {
        void load();
      }, [sessionId, load]);

      React.useEffect(function () {
        if (flash === null) return undefined;
        var timer = setTimeout(function () {
          setFlash(null);
        }, FLASH_MS);
        return function () {
          clearTimeout(timer);
        };
      }, [flash]);

      var rows = React.useMemo(function () {
        return observedModelRows(overview);
      }, [overview]);
      var unpriced = React.useMemo(function () {
        return unpricedIndex(overview);
      }, [overview]);
      var serverConfigDraft = React.useMemo(function () {
        return configDraftFrom(overview, rows);
      }, [overview, rows]);
      var configDraft = React.useMemo(function () {
        return configEdit === null ? serverConfigDraft : mergeConfigDrafts(serverConfigDraft, configEdit);
      }, [configEdit, serverConfigDraft]);
      var configDirty = React.useMemo(function () {
        if (configEdit === null) return false;
        return JSON.stringify(serializeVisibleConfig(configDraft)) !== JSON.stringify(serializeVisibleConfig(serverConfigDraft));
      }, [configEdit, configDraft, serverConfigDraft]);

      // Drop an edit state that exactly matches the server, so later polls stay visible.
      React.useEffect(function () {
        if (configEdit === null) return;
        if (JSON.stringify(serializeVisibleConfig(configDraft)) === JSON.stringify(serializeVisibleConfig(serverConfigDraft))) {
          setConfigEdit(null);
        }
      }, [configEdit, configDraft, serverConfigDraft]);

      // First ready load without a session: 本会话 would be an empty row, so start at 今天.
      var seededPeriodRef = React.useRef(false);
      React.useEffect(function () {
        if (seededPeriodRef.current || overviewRecord === null) return;
        seededPeriodRef.current = true;
        if ((overviewRecord.sessionId === null || overviewRecord.sessionId === undefined) && selectedPeriod === 'session') {
          setSelectedPeriod('today');
        }
      }, [overviewRecord, selectedPeriod]);

      var serverBalances = React.useMemo(function () {
        return balanceServerDraft(overview);
      }, [overview]);
      var mergedBalances = React.useMemo(function () {
        return mergeBalanceDraft(serverBalances, balanceEdit);
      }, [serverBalances, balanceEdit]);
      var balanceDirty = React.useMemo(function () {
        return dirtyBalanceProviders(mergedBalances, serverBalances);
      }, [mergedBalances, serverBalances]);

      React.useEffect(function () {
        if (balanceEdit === null) return;
        var next = {};
        var providers = Object.keys(balanceEdit);
        for (var i = 0; i < providers.length; i++) {
          var provider = providers[i];
          if (!Object.prototype.hasOwnProperty.call(serverBalances, provider)) continue;
          if (amountKey(balanceEdit[provider]) !== amountKey(serverBalances[provider])) next[provider] = balanceEdit[provider];
        }
        if (Object.keys(next).length === 0) {
          setBalanceEdit(null);
          return;
        }
        if (sparseSignature(next) !== sparseSignature(balanceEdit)) setBalanceEdit(next);
      }, [balanceEdit, serverBalances]);

      function changeCurrency(value) {
        setConfigEdit(function (current) {
          var base = current === null ? serverConfigDraft : mergeConfigDrafts(serverConfigDraft, current);
          return { currency: value, models: base.models };
        });
      }

      function changeRule(id, patch) {
        setConfigEdit(function (current) {
          var base = current === null ? serverConfigDraft : mergeConfigDrafts(serverConfigDraft, current);
          var rule = base.models[id] || blankRuleDraft();
          var models = {};
          var ids = Object.keys(base.models);
          for (var i = 0; i < ids.length; i++) models[ids[i]] = base.models[ids[i]];
          models[id] = Object.assign({}, rule, patch);
          return { currency: base.currency, models: models };
        });
      }

      function changePrice(id, tier, key, value) {
        setConfigEdit(function (current) {
          var base = current === null ? serverConfigDraft : mergeConfigDrafts(serverConfigDraft, current);
          var rule = base.models[id] || blankRuleDraft();
          var tierKey = tier === 'valley' || tier === 'long' ? tier : 'base';
          var prices = Object.assign({}, rule[tierKey]);
          prices[key] = value;
          var nextRule = Object.assign({}, rule);
          nextRule[tierKey] = prices;
          var models = {};
          var ids = Object.keys(base.models);
          for (var i = 0; i < ids.length; i++) models[ids[i]] = base.models[ids[i]];
          models[id] = nextRule;
          return { currency: base.currency, models: models };
        });
      }

      async function saveConfigDraft() {
        if (savingConfig) return;
        var snapshot = configEdit === null ? serverConfigDraft : configEdit;
        setSavingConfig(true);
        setError('');
        try {
          await request('saveConfig', { config: serializeSaveConfig(overview, snapshot) });
          notifyOverviewChanged();
          setConfigEdit(function (current) {
            return current === snapshot ? null : current;
          });
          setFlash({ key: 'priceSaved' });
          await load();
        } catch (failure) {
          setError(errorMessage(failure));
        } finally {
          setSavingConfig(false);
        }
      }

      function changeBalance(provider, value) {
        setBalanceEdit(function (current) {
          var next = {};
          if (isRecord(current)) {
            var keys = Object.keys(current);
            for (var i = 0; i < keys.length; i++) next[keys[i]] = current[keys[i]];
          }
          next[provider] = value;
          if (amountKey(next[provider]) === amountKey(serverBalances[provider])) delete next[provider];
          return Object.keys(next).length === 0 ? null : next;
        });
      }

      async function saveBalanceDraft() {
        if (savingBalance) return;
        var providers = balanceDirty;
        if (providers.length === 0) return;
        var parsed = {};
        for (var i = 0; i < providers.length; i++) {
          var parsedValue = parseAmountInput(mergedBalances[providers[i]]);
          if (!parsedValue.valid) {
            setError(t('balanceInvalid'));
            return;
          }
          parsed[providers[i]] = parsedValue.value;
        }
        setSavingBalance(true);
        setError('');
        try {
          for (var j = 0; j < providers.length; j++) {
            await request('saveBalance', { provider: providers[j], amount: parsed[providers[j]] });
          }
          notifyOverviewChanged();
          setFlash({ key: 'balanceSaved' });
          await load();
        } catch (failure) {
          setError(errorMessage(failure));
        } finally {
          setSavingBalance(false);
        }
      }

      var header = h('header', { className: '__tu_header' },
        h('div', { className: '__tu_heading' },
          h('h1', { className: '__tu_title' }, t('title')),
          h('span', { className: '__tu_status' },
            pending ? (overviewRecord === null ? t('loading') : t('refreshing')) : overviewRecord && overviewRecord.generatedAt ? t('updatedAt') + ' ' + formatTimestamp(overviewRecord.generatedAt) : '')),
        flash !== null ? h('span', { className: '__tu_flash' }, '✓ ' + t(flash.key)) : null,
        h('button', {
          type: 'button',
          className: '__tu_button',
          onClick: function () {
            void load();
          },
          disabled: pending
        },
        h('span', { className: '__tu_refreshIcon', 'aria-hidden': 'true' }, '⟳'), t('refresh')),
        h('button', {
          type: 'button',
          className: '__tu_button __tu_iconBtn',
          title: t('close'),
          'aria-label': t('close'),
          onClick: function () {
            if (typeof props.onClose === 'function') props.onClose();
          }
        }, h('span', { 'aria-hidden': 'true' }, '✕')));

      var errorBanner = error !== ''
        ? h('div', { className: '__tu_banner __tu_banner--error', role: 'alert' },
            h('span', { className: '__tu_bannerText' }, t('errorPrefix') + ': ' + error),
            h('button', {
              type: 'button',
              className: '__tu_button',
              onClick: function () {
                void load();
              }
            }, t('retry')))
        : null;

      var incompleteBanner = overviewRecord && overviewRecord.incomplete === true
        ? h('div', { className: '__tu_banner __tu_banner--warn', role: 'status', 'aria-live': 'polite' }, t('incomplete'))
        : null;

      var body;
      if (overviewRecord === null) {
        body = pending
          ? h('div', { className: '__tu_emptyState' },
              h('span', { className: '__tu_spinner', 'aria-hidden': 'true' }),
              t('loading'))
          : h('p', { className: '__tu_emptyState' }, t('loadFailed'));
      } else {
        body = h('div', { className: '__tu_sections' },
          h(BalanceSection, { t: t, overview: overviewRecord }),
          h(StatsSection, {
            t: t,
            overview: overviewRecord,
            selected: selectedPeriod,
            unpriced: unpriced,
            onSelect: setSelectedPeriod
          }),
          h(PriceEditor, {
            t: t,
            draft: configDraft,
            rows: rows,
            dirty: configDirty,
            saving: savingConfig,
            onCurrency: changeCurrency,
            onRule: changeRule,
            onPrice: changePrice,
            onSave: saveConfigDraft
          }),
          h(BalanceEditor, {
            t: t,
            rows: editableBalanceRows(overviewRecord),
            values: mergedBalances,
            dirty: balanceDirty,
            currency: overviewRecord.currency,
            saving: savingBalance,
            onChange: changeBalance,
            onSave: saveBalanceDraft
          }));
      }

      return element('div', { className: '__tu_root' }, [header, errorBanner, incompleteBanner, body]);
    }

    /* ── Plugin body ───────────────────────────────────────────────────── */

    var inject = ['slots', 'locale', 'layout'];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'dsh-token-usage: dictionaries');
      var t = ctx.locale.bind(NS);
      var layout = typeof ctx.get === 'function' ? (ctx.get('layout') ?? ctx.layout) : ctx.layout;

      /** Open (or keep) the balance panel in the main column. */
      function openPanel() {
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID);
      }

      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: PANEL_ID,
          order: FOOTER_ORDER,
          locale: NS,
          label: function () {
            return t('panel');
          }
        }, function (props) {
          return h(FooterBalance, Object.assign({}, props, { t: t, onOpen: openPanel }));
        });
      });

      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS
        }, function (props) {
          return h(TokenUsagePanel, Object.assign({}, props, {
            t: t,
            onClose: function () {
              if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null);
            }
          }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
