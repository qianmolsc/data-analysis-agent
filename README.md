# 数据分析 Agent

用一句自然语言，把一份表格数据问出结论。

上传 CSV / Excel 或直接粘贴表格，然后问：「按月看销售额趋势，哪几个月明显异常？」Agent 会自动规划查询、按真实数据计算指标、生成图表，并给出四段式分析结论。

**在线体验**：https://data-analysis-agent-37742.app.workbuddy.host/?sharecode=MDLWGW7HWJ

---

## 它解决什么问题

传统「AI 分析数据」的做法是把表格塞给大模型，让它直接回答数字。问题是模型会算错、会编造，而且一旦数据量稍大就不可靠。

这个项目的核心取舍是 **数字不让模型算**：

- 大模型只做两件事：把自然语言问题翻译成结构化的查询计划；解读已经算好的结果并写成人话。
- 所有聚合、增长率、异常判定都由本地引擎在真实数据上计算。

所以图表里的每一个数字都能追溯到原始行，不会出现幻觉。

## 功能

| 能力 | 说明 |
| --- | --- |
| 数据接入 | CSV / TSV / TXT / JSON / XLSX 上传、拖拽、粘贴表格（支持直接从 Excel 粘贴） |
| 类型推断 | 自动识别数值列、日期列、文本列，数值列兼容千分位、货币符号、百分号 |
| 趋势分析 | 按日 / 周 / 月 / 季 / 年自动选择合适粒度，输出峰值、谷值、整体增速 |
| 异常识别 | 时间序列去趋势后用 MAD 稳健 z 分数判定；类别数据用 IQR 围栏 |
| 指标对比 | 两个取值的差额与百分比变化，支持多指标并列 |
| 排名与构成 | TOP N 排名、占比、自动合并「其他」项 |
| 可视化 | 折线 / 柱状 / 饼图 / 环图 / 明细表，多指标双序列 |
| 云端持久化 | 数据集与分析历史存云端，跨设备可继续 |

内置一份示例数据（18 个月 × 3 区域 × 3 产品线，含两个刻意埋入的异常月），没有数据也能一键试跑。

## 架构

```
用户提问
   │
   ├─ app.js  ──→ 大模型：把问题翻译成查询计划 JSON
   │                { intent, groupBy, metrics, filters, chartType }
   │
   ├─ analytics.js ──→ 在真实数据上执行计划
   │                   聚合 / 排序 / 统计 / 异常检测  ← 所有数字在这里算出
   │
   ├─ app.js  ──→ 大模型：基于算好的结果写结论（四段式）
   │              └─→ Chart.js 渲染图表
   │
   └─ 写入云端 analyses 表
```

三个脚本各司其职，加载顺序即依赖顺序：

| 文件 | 职责 | 行数 |
| --- | --- | --- |
| `assets/config.js` | 云端地址、客户端公钥、上传限额（**不入库，用 example 模板生成**） | 14 |
| `assets/analytics.js` | 纯计算引擎：解析 → 类型推断 → 聚合 → 统计与异常。不碰 DOM，可单独测试 | ~760 |
| `assets/app.js` | 应用逻辑：认证、云端 CRUD、模型调用、渲染、事件绑定 | ~1390 |

### 异常检测算法

时间序列的异常点会被线性回归自身带偏（一个极端值会把趋势线拉过去，导致它自己反而显得「正常」），所以这里用**留一法**：对每个点，用其余点拟合趋势，看该点的残差。残差再用 **MAD（中位数绝对偏差）** 归一化得到稳健 z 分数，比标准差更抗离群值。

判定条件：`|z| ≥ 2.5` 且 `|残差| ≥ 均值的 3%`（后者用来过滤掉大基数数据上的微小波动）。

非时间序列的类别数据则用 IQR 围栏：超出 `Q1 - 1.5·IQR` 或 `Q3 + 1.5·IQR` 视为异常。

## 快速开始

### 1. 准备云端配置

```bash
git clone <this-repo>
cd <repo>
cp assets/config.example.js assets/config.js
```

编辑 `assets/config.js`，填入你自己的云服务参数：

```js
window.APP_CONFIG = {
  cloud: {
    endpoint: 'https://your-app.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_xxxxxxxx'
  },
  limits: { maxRows: 3000, maxColumns: 60, maxFileMB: 8, maxPromptChars: 400 }
};
```

本项目依赖 [WorkBuddy 云服务](https://www.workbuddy.cn/) 提供数据库、用户认证和免密钥的大模型通道。换用其他后端需要改写 `app.js` 中的 `initCloud()` 及数据访问层。

### 2. 建表

在云服务数据库中执行：

```sql
CREATE TABLE datasets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  owner_name TEXT,
  name TEXT NOT NULL,
  source_type TEXT DEFAULT 'upload',
  columns_def JSONB NOT NULL DEFAULT '[]'::jsonb,
  rows_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE analyses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  owner_name TEXT,
  dataset_id BIGINT NOT NULL,
  dataset_name TEXT,
  question TEXT NOT NULL,
  intent TEXT,
  plan JSONB,
  result JSONB,
  answer TEXT,
  chart JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

两张表都要启用行级安全并加 owner-only 策略，确保用户之间数据隔离：

```sql
ALTER TABLE datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.datasets TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analyses TO authenticated, anon;
GRANT USAGE, SELECT ON SEQUENCE datasets_id_seq TO authenticated, anon;
GRANT USAGE, SELECT ON SEQUENCE analyses_id_seq TO authenticated, anon;

CREATE POLICY datasets_select_own ON datasets FOR SELECT TO authenticated, anon
  USING (owner_id = auth.uid());
CREATE POLICY datasets_insert_own ON datasets FOR INSERT TO authenticated, anon
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY datasets_update_own ON datasets FOR UPDATE TO authenticated, anon
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY datasets_delete_own ON datasets FOR DELETE TO authenticated, anon
  USING (owner_id = auth.uid());

-- analyses 表同理，四条策略
```

### 3. 打开页面

纯静态站点，无需构建：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

登录采用邮箱或手机号验证码（免密码，首次登录自动创建账号），需要在云服务控制台开启对应的登录方式。

## 目录结构

```
.
├── index.html                 应用外壳：登录 / 侧边栏 / 工作区 / 弹窗
├── assets/
│   ├── config.js              本地云端配置（git 忽略）
│   ├── config.example.js      配置模板
│   ├── analytics.js           数据引擎（无 DOM 依赖）
│   ├── app.js                 应用逻辑
│   └── styles.css             设计系统
├── LICENSE
└── README.md
```

## 技术栈

纯静态，无构建步骤。所有依赖走 CDN：

- [Chart.js 4.4](https://www.chartjs.org/) 图表渲染
- [SheetJS 0.18](https://sheetjs.com/) 解析 xlsx
- [WorkBuddy Cloud SDK](https://www.workbuddy.cn/) 数据库 / 认证 / 大模型

没有用框架，`app.js` 是原生 DOM 操作。优点是零构建、单文件可读；代价是复杂页面需要手工管理状态。

## 已知限制

- 单个数据集上限 3000 行 × 60 列 —— 数据整体以 JSONB 存库，行数再多会显著拖慢加载。
- 一次只分析一个数据集，不支持多表关联。
- 查询计划由模型生成，极复杂的问题（多步嵌套筛选、窗口函数类需求）可能规划失败，此时会退回按维度汇总的兜底计划。
- 中文字段名支持良好，但字段名高度同义（如「金额」「销售额」「营收」并存）时，模型可能选错列。

## License

[MIT](LICENSE)
