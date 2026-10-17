# evals — 经典 Excel 处理案例

这里放的是网上流传最广的那一批 Excel 处理练习，改写成这个应用的输入方式：
给一张起始表，再用用户在输入框里会说的那句话提要求，最后用确定性的断言检查
模型通过工具改出来的表对不对。

`tests/` 验证的是代码自己的决定（闸、重放、校验），模型是脚本假扮的；
`evals/` 跑的是**真模型**，验证的是「模型 + 工具 + 闸」合在一起能不能把这些
经典任务做对。它花真实配额，不在 `pnpm test` 里。

## 运行

```powershell
node evals/run.js                      # 全部案例
node evals/run.js --only=payroll       # 只跑一个（按 id，或文件名前缀如 05）
node evals/run.js --dry                # 不调模型：只加载、归一化、校验起始表
node evals/run.js --data-dir=D:\xl     # settings.json（模型配置）所在目录
```

不给 `--data-dir` 时依次找 `TAB_AGENT_HOME`、仓库的 `data/`、`%APPDATA%\ETabAgent`，
和应用自己找配置的顺序一致。每轮的回复、操作列表和结果 spec 落在 `evals/out/`
（已忽略），汇总在 `evals/out/last-run.json`。

## 案例

| 文件 | 经典任务 | 对应的 Excel 做法 | 主要考察 |
|---|---|---|---|
| `01-payroll` | 工资表：应发、实发、合计行 | SUM、加减公式、合计行 | `compute_column`、`set_totals` |
| `02-attendance` | 考勤：缺勤天数、考勤状态，再问每天缺勤人数 | COUNTIF、IF、条件格式 | 多列计数、第二轮只答不改 |
| `03-sales-pivot` | 按销售员汇总金额，另起一张表 | 数据透视表 | `query_table` + `saveAs`、排序 |
| `04-vlookup` | 按产品编号把名称、单价带到订单表 | VLOOKUP / INDEX-MATCH | `lookup_columns`，匹配不到留空 |
| `05-grades` | 成绩表：总分、平均分、等级；再排序加名次 | SUM、AVERAGE、嵌套 IF、RANK | 两轮连续修改、`sort_rows`、首列插入 |
| `06-dedupe` | 按手机号删除重复客户 | 删除重复项 | 删行要过闸、保留首条 |
| `07-split-column` | 「张三-销售部-北京」拆三列并删原列 | 分列 | 文本拆分、`remove_columns` |
| `08-id-card` | 身份证号提取出生日期、性别、周岁 | MID、MOD、DATEDIF | 文本函数、日期类型、按给定日期算年龄 |
| `09-inventory` | 进销存：结存、低于安全库存标「补货」 | 加减公式、IF、条件格式 | `compute_column`、IF |
| `10-sumif-countif` | 三个只问不改的统计问题 | SUMIF、COUNTIF、SUMIFS | `query_table`，不得产生编辑操作 |
| `11-filter-sort` | 只留金额 > 5000 的记录并降序 | 筛选 + 排序 | 边界值（恰好 5000 要删掉）、删行过闸 |
| `12-ar-aging` | 应收账款逾期天数与账龄区间 | DATEDIF、IF 分段 | 日期差、区间归类 |
| `13-budget-actual` | 预算 vs 实际：差异、完成率（分母 0 留空）、合计 | 除法、IF/IFERROR、百分比格式 | percent 列类型、留空、合计行 |
| `14-text-cleanup` | 去空格、首字母大写、按格式补邮箱 | TRIM、PROPER、&、快速填充 | 文本清洗、只改空的行（where） |
| `15-monthly-summary` | 按月汇总金额和订单数 | 透视表按月分组 | `groupBy` 用表达式 MONTH([日期]) |
| `16-reconcile` | 财务表与上传的业务系统导出按发票号对账；再问只在附件里的发票 | 跨工作簿 VLOOKUP + IF/IFERROR | 附件导入、`lookup_columns`、三态核对、第二轮只答不改 |
| `17-consolidate` | 三个月份的上传文件合并成一张明细并标月份，再按销售员汇总 | Power Query 合并多工作簿 + 透视表 | 没有起始表、多附件读取与追加、`query_table` |
| `18-dept-salary` | 用上传的部门表给员工表补部门名，再按部门汇总总额、人数、平均 | 跨文件 VLOOKUP + 按部门透视 | 附件先导入再 `lookup_columns`、多指标分组 |

后三个是「多个 Excel 文件一起操作」的案例：`attachments` 里的每个文件会被真的写成 xlsx，
再走和拖拽上传完全一样的解析路径，消息里也带上和服务端一样的附件预览。
本应用只有一个当前工作簿，其他文件都以附件身份出现，所以跨文件的 VLOOKUP 和合并
都要先把附件导入成工作表（`read_attachment` 的 `importAs`）再做。

身份证号全部是编造的，校验位不一定成立，案例只用前 17 位。

## 案例格式

一个案例一个 JSON 文件：

```jsonc
{
  "id": "payroll",                   // --only 用的名字
  "title": "工资表：应发、实发与合计行",
  "source": [{ "name": "...", "url": "..." }],  // 案例的出处
  "tags": ["compute_column"],
  "given": { "title": "...", "sheets": [{ "name": "...", "columns": [...], "rows": [...] }] },
  "attachments": [                   // 可选：这一轮「上传」的文件
    { "filename": "部门表.xlsx", "spec": { "sheets": [ ... ] } },   // 写成真 xlsx 再解析
    { "filename": "名单.csv", "text": "姓名,部门\n张三,销售部" }     // 或者原样的文本文件
  ],
  "today": "2026-10-17",             // 可选：这一轮的「今天」，算年龄、账龄时要固定住
  "turns": [
    { "message": "用户说的那句话", "expect": { ... } }
  ]
}
```

`given` 是模型回复里那种 raw spec，跑之前先过 `normalizeSpec` + `validateSpec`，
和应用处理模型输出的路径一致；日期列直接写 `"2026-01-05"`。多轮时，上一轮落下的
表就是下一轮的起始表，历史也一并带上，和服务端一样。

`expect` 里每一项都是独立的检查，列名一律按正则匹配（大小写不敏感），
所以写 `"金额|销售额"` 可以容忍模型起的列名：

| 字段 | 含义 |
|---|---|
| `intent` | `action` / `answer` / `question` |
| `guarded: false` | 没有被行数闸拦下 |
| `ops: "none"` | 本轮没有任何编辑操作（只问不改） |
| `reply` | 回复必须匹配的正则列表 |
| `sheetCount` | 工作表数 |
| `sheet` | 下面的检查针对哪张表（正则）；省略为第一张 |
| `rowCount` / `rowCountMin` | 行数（不含表头、合计行） |
| `columns` / `noColumns` | 必须有 / 必须没有的列 |
| `firstColumn` | 第一列的列名 |
| `columnTypes` | `{ "列名": "date" }`，列类型 |
| `totals` | 是否有合计行 |
| `cells` | `{ row, column, equals \| approx (+tolerance) \| matches }`，`row` 从 1 起；日期按 `YYYY-MM-DD` 比 |
| `sortedBy` | `{ column, order: "asc" \| "desc" }`，空值不参与 |
| `unique` | 这一列没有重复值 |

## 来源

- ExcelDemy — [Excel Practice Test for Employment](https://exceldemy.com/?p=293888)（数空单元格与补邮箱、VLOOKUP/INDEX-MATCH、拆姓名、销售统计、筛选排序、透视表、三天考勤、图表）
- ExcelDemy — [Excel VLOOKUP Exercises: 10 Tricky Problems](https://www.exceldemy.com/excel-vlookup-exercises/)（工资查找、按区间分组、关联表查价格、找重复）
- 人人都是产品经理 — [Excel 数据处理九个场景](https://www.woshipm.com/data-analysis/5748189.html)（透视表、VLOOKUP、SUMIF/SUMIFS、COUNTIF/COUNTIFS、IF、IFERROR、条件格式）
- 帆软 — [数据清洗：去重与分列](https://www.fanruan.com/blog/article/1466567/)、[数据透视表场景](https://www.fanruan.com/blog/article/309671/)、[分列的典型用法](https://www.fanruan.com/blog/article/852354/)
- 清华大学出版社 — [《Excel 数据处理与分析》](https://www.tup.tsinghua.edu.cn/upload/books/yz/076116-02.pdf)（销售、人事、薪资）、[《新编 Excel 在财务中的应用》](https://www.tup.tsinghua.edu.cn/upload/books/yz/076002-01.pdf)（工资核算、购销存）
- [Microsoft Excel Practical Exercises Questions](https://www.mcsprogram.org/index.jsp/u14A20/242460/Microsoft%20Excel%20Practical%20Exercises%20Questions.pdf)（按部门透视、按 ID 查产品名、阈值高亮）
- Scribd — [Grade Sheet 练习](https://www.scribd.com/document/375396591/exer1)、ExcelDemy — [Calculate Final Grade](https://www.exceldemy.com/calculate-final-grade-in-excel/)、PinoyTechnoGuide — [How to Rank in Excel](https://www.pinoytechnoguide.com/2012/04/ranking-in-exce.html)
- 网易号 — [身份证号判断性别](https://www.163.com/dy/article/EN51MPDF05449WI4.html)、CSDN — [身份证号提取出生日期](https://gitcode.csdn.net/6aa0d89e1a35784c8420655f.html)
- 实在智能 — [库存统计表结构](https://www.ai-indeed.com/encyclopedia/17055.html)、[进销存与安全库存预警](https://www.ai-indeed.com/encyclopedia/16395.html)、[账龄分析](https://www.ai-indeed.com/encyclopedia/17061.html)；CSDN 论坛 — [库存情况表](https://bbs.csdn.net/topics/20239566)
- 少数派 — [Microsoft 365 工具升值包：Excel 专题](https://sspai.com/post/68793)
- Chandoo — [Compare two Excel sheets using VLOOKUP](https://chandoo.org/wp/compare-two-excel-sheets-using-vlookup)、ExcelDemy — [How to Do Reconciliation in Excel](https://www.exceldemy.com/how-to-do-reconciliation-in-excel/)、WPS — [两列比对找不匹配值](https://www.wps.com/office-quick-solution/excel-data-problems/how-to-compare-two-columns-in-excel-and-find-mismatched-values/)（对账）
- IT之家 — [Power Query 合并多个工作簿](https://www.ithome.com/0/675/883.htm)、Microsoft 支持 — [Combine multiple data sources (Power Query)](https://support.microsoft.com/en-US/Excel/learn-to-combine-multiple-data-sources-power-query)（多文件合并）
- Chase Jarvis — [Exercise for Excel Practice](https://podcast.chasejarvis.com/2024/exercise-for-excel-practice)（按部门平均工资的透视表）

## 加案例

挑一个网上反复出现、答案能用算术算出来的任务；起始表控制在 15 行以内，
期望值手算一遍写进 `cells`；凡是模型可以合理起不同名字的列，选择器写成正则；
会删行的任务，那句话里要出现「删」「去掉」这类词，否则行数闸会拦下。
先 `--dry` 确认起始表能归一化，再 `--only=` 跑真模型。
