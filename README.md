# 焊程见证台（Welding Process Witness Stand）

本地焊接工艺评定（PQR/WPQR）资格覆盖核对服务：工程人员录入一份待核生产工艺，
系统依据**本地规则包**逐变量判定现有资格记录能否完整覆盖，列出命中证据、缺口、
离合格最近的试验，并支持比较两个规则版本造成的覆盖范围变化。

- 语言/运行时：TypeScript（Node.js 原生类型擦除，无需构建步骤）
- 存储：内置 `node:sqlite`（SQLite，WAL），数据库文件位于 `data/witness.sqlite`
- 前端：原生操作页面 + HTML5 Canvas 区间图（零运行时依赖）
- 规则：受限算术表达式（只含数字、变量 `v`、`+ - * / ( )`、一元负号），**递归下降解析，不执行任意代码**

## 安装与演示

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run && corepack pnpm dev --host 127.0.0.1 --port 5515
```

浏览器访问 <http://127.0.0.1:5515>，页面标题为 **焊程见证台**。

其他命令：

| 命令 | 作用 |
| --- | --- |
| `corepack pnpm dev --host … --port …` | 启动服务（`node --watch`，改代码自动重启） |
| `corepack pnpm start` | 不带 watch 启动 |
| `corepack pnpm test -- --run` | 运行全部自动化测试（32 项），单次运行后退出 |
| `corepack pnpm typecheck` | `tsc --noEmit` 严格类型检查 |
| `corepack pnpm replay` | 清空数据库并从 `fixtures/` 重放固定数据 |

## 数据口径

### 标称值与实测值分开存储

区间变量（厚度、热输入、直径）在试件与生产工艺两侧都分别记录：

- `nominal`：标称值（工艺声明值）
- `measured`：实测值（检测/见证记录值）

规则在每个区间变量上用 `productionValue` / `couponValue` 声明评估取哪一个；
未被选用的值只存档，**不会被偷偷拿来补覆盖**。
固定 fixture 中热输入按工程惯例取**试件实测值**、生产标称值进行判定。

### 开闭区间与界限判定

区间扩展边界由规则包显式声明：

- `bound: "closed"`：含界，`[ ]`；`bound: "open"`：不含界，`( )`
- 生产工艺值**恰好落在界限上**时，严格按声明判定：
  - 2024.1 厚度 `[0.5t, 2t]` 为闭区间，生产厚度恰好 `2t` → 覆盖；
  - 2025.0 热输入为半开范围 `[0.5Q, 1.2Q)`，生产热输入恰好 `1.2Q` → **不覆盖**，
    `1.2Q - ε` 才覆盖；下界 `0.5Q` 为闭，恰好 `0.5Q` → 覆盖。

内置规则包 `wws-welding-pqr`（`fixtures/rules.json`）两版摘要：

| 变量 | 2024.1 | 2025.0 |
| --- | --- | --- |
| 厚度（闭区间，mm，取标称） | `[0.5v, 2v]` | `[0.7v, 1.5v]`（收窄） |
| 热输入（取试件实测，kJ/mm） | `[0.5v, v]` 闭 | `[0.5v, 1.2v)` 半开（放宽，上界不含） |
| 直径（mm，取标称） | `[0.5v, +∞)` | 不变 |
| 母材组 / 填充材料 / 位置 | 分类精确匹配 | 不变 |
| 联合组 | 单一组包含全部 6 个变量 | 拆为 `joint-core`、`joint-heat` 两组 |
| 跨试件拼接 | `forbidden` | `permitted`（仅允许按组拼接） |
| 必检力学项 | 拉伸、弯曲 | 拉伸、弯曲、**冲击** |

### 联合组与拼接

- 每个 `jointGroup` 中的变量必须由**同一试件**联合证明；
  不允许把 A 试件的母材与 B 试件的厚度拼成一个组。
- `stitching: "forbidden"`（2024.1）：必须存在**单一试件**联合满足全部组，
  两个单项合格试件的证据再互补也不构成覆盖，系统会明确给出“禁止跨试件拼接”的拒绝理由。
- `stitching: "permitted"`（2025.0）：允许不同组的证据来自不同试件，
  但组内仍要求同一试件。

### 记录状态、单位与力学检验

- `expired`（过期）、`withdrawn`（撤销）记录整条排除，参数再匹配也不作证据；
- 数值证据必须显式携带与规则声明一致的单位。单位缺失 → `UNIT_UNKNOWN`，
  单位不一致 → `UNIT_MISMATCH`，该试件整条排除（`WPQR-004` 即单位不明的反例）；
- `requiredMechanical` 中任一必检项缺合格记录（未做或不合格）→
  `MECHANICAL_INCOMPLETE`，排除出证据；
- 排除原因会逐条形文展示，不会“偷偷参与”。

### 结论固定规则包摘要

- 规则包与每个版本均按**规范化 JSON（键排序）计算 SHA-256 摘要**；
- 每次评估结论都携带 `packageDigest` 与 `versionDigest`，并随运行记录入库；
- 同一输入在任意机器上复算得到同一摘要、同一结论。

## 页面结构

- **覆盖核对**：选择规则版本、载入固定工艺或手工录入；按变量展示命中证据
  （含每条证据声明的数值区间与开闭界）、缺口、联合组判定、离合格最近的试验及所缺证据；
  Canvas 绘制各试件覆盖区间与生产值位置（绿界=闭，橙界=开）。
- **版本比较**：选择两个版本，展示每个区间变量的表达式变化、收窄/放宽判定，
  以及以固定样例试件值计算的新旧数值区间，Canvas 叠加对比。
- **运行记录**：全部核对结论可查、可展开、可导出 JSON；支持导入导出包复核、
  一键清空并重放 fixture。
- **证据台账**：全部试件与固定生产工艺，过期/撤销/单位不明/力学不合格记录标红。

## 清空、重放与导入复核

1. 清空：页面“清空并重放 fixture”，或 `POST /api/replay`，或 `corepack pnpm replay`；
2. 导出：页面“导出运行数据包”，或 `GET /api/export`
   （含规则包、试件、生产工艺、全部运行记录）；
3. 导入：页面选择导出 JSON，或 `POST /api/import`；
4. 复核：导入后重新执行同一核对，结论与规则摘要必须完全一致
   （该回路在 `tests/persistence.test.ts` 中自动化）。

服务首次启动若数据库为空，会自动从 `fixtures/` 重放固定数据。

## HTTP 接口

| 方法/路径 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/packages/current` | 规则包元信息与摘要 |
| `GET /api/versions` | 全部版本的完整规则定义 |
| `GET /api/coupons` / `GET /api/specs` | 试件 / 固定生产工艺 |
| `POST /api/evaluate` | 执行覆盖核对，body：`{version, spec:{id}}` 或完整 spec |
| `GET /api/compare?from=&to=` | 两版本范围变化 |
| `GET /api/runs` / `GET /api/runs/:id` | 运行记录列表/详情 |
| `GET /api/export` / `POST /api/import` / `POST /api/replay` | 导出/导入/重放 |

## 验收 fixture 与场景

- `PQR-A-007`：core 组（母材/填充/厚度）完整，位置为 PF（缺 PA）；
- `PQR-B-013`：heat 组（直径/位置/热输入）完整，母材为 Fe-3（缺 Fe-1）；
- `P1` 工艺：2025.0 下两组分别由 A、B 证明 → **COVERED（允许拼接）**；
  2024.1 下无单一试件联合满足全部变量 → **NOT_COVERED（拒绝虚假拼接）**，
  并指出离合格最近的试件（命中 5/6 变量）仍缺哪条证据；
- `WPQR-002/003/004/006`：过期、撤销、单位不明、力学不合格四类反例；
- `P3` + `WPQR-001`：2024.1 单一试件覆盖；2025.0 因新增冲击必检项变为缺口，
  最近试验提示“补齐 impact 合格记录”。

## 目录

```
fixtures/      固定规则包、试件、生产工艺（重放唯一数据源）
src/           类型、受限表达式、摘要、区间引擎、SQLite、HTTP 服务、fixture 装载
web/           操作页面（index.html / app.js / styles.css，Canvas 绘图）
tests/         32 项自动化测试（引擎、界限、拼接验收、排除、摘要、持久化、HTTP）
scripts/       零依赖测试运行器与 CLI 重放
data/          SQLite 数据库（git 忽略，可随时清空重放）
```
