"use strict";

const state = {
  pkg: null,
  versions: [],
  specs: [],
  coupons: [],
  currentResult: null,
  editorSpec: null,
};

const VARIABLE_LABELS = {
  baseMaterial: "母材组",
  filler: "填充材料",
  thickness: "厚度",
  diameter: "直径",
  position: "位置",
  heatInput: "热输入",
};
const label = (name) => VARIABLE_LABELS[name] || name;

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function currentRule() {
  const version = document.getElementById("versionSelect").value;
  return state.pkg?.versions?.find((v) => v.version === version) || null;
}

async function bootstrap() {
  const meta = await api("/api/packages/current");
  state.pkgDigest = meta.digest;
  state.pkg = { packageId: meta.packageId, unitRegistry: meta.unitRegistry, versions: [] };
  state.versions = await api("/api/versions");
  state.pkg.versions = state.versions;
  state.specs = await api("/api/specs");
  state.coupons = await api("/api/coupons");

  document.getElementById("packageMeta").textContent =
    `规则包 ${meta.packageId} ・摘要 ${meta.digest.slice(0, 16)}… ・${meta.versions.length} 个版本`;

  fillVersionSelectors(meta.versions);
  fillSpecSelect();
  renderEditor();
  renderDataTab();
}

function fillVersionSelectors(versions) {
  const selects = [document.getElementById("versionSelect"), document.getElementById("compareFrom"), document.getElementById("compareTo")];
  for (const select of selects) {
    select.innerHTML = "";
    for (const version of versions) {
      const option = document.createElement("option");
      option.value = version.version;
      option.textContent = `${version.version} — ${version.label}`;
      select.appendChild(option);
    }
  }
  if (versions[0]) document.getElementById("compareFrom").value = versions[0].version;
  if (versions[1]) document.getElementById("compareTo").value = versions[1].version;
  if (versions[0]) document.getElementById("versionSelect").value = versions[0].version;
}

function fillSpecSelect() {
  const select = document.getElementById("specSelect");
  select.innerHTML = '<option value="">— 自定义录入 —</option>';
  state.specs.forEach((spec) => {
    const option = document.createElement("option");
    option.value = spec.id;
    option.textContent = spec.name;
    select.appendChild(option);
  });
}

function renderEditor() {
  const rule = currentRule();
  const container = document.getElementById("specEditor");
  container.innerHTML = "";
  if (!rule) return;
  state.editorSpec = { name: "自定义工艺", variables: [] };
  for (const name of rule.requiredVariables) {
    const definition = rule.variables[name];
    const card = document.createElement("div");
    card.className = "field";
    if (definition.kind === "categorical") {
      card.innerHTML = `<div class="fname">${label(name)}</div>
        <div class="row"><select data-var="${name}" data-kind="text">
          ${definition.values.map((v) => `<option>${v}</option>`).join("")}
        </select></div>`;
    } else {
      const source = definition.productionValue === "nominal" ? "标称值（评估使用）" : "实测值（评估使用）";
      card.innerHTML = `<div class="fname">${label(name)} <span class="unit-tag">[${definition.unit}]</span></div>
        <div class="row"><input data-var="${name}" data-kind="${definition.productionValue}" data-unit="${definition.unit}"
          placeholder="${source}" /></div>
        <div class="row"><input data-var="${name}" data-kind="${definition.productionValue === "nominal" ? "measured" : "nominal"}" data-unit="${definition.unit}"
          placeholder="${definition.productionValue === "nominal" ? "实测值（存档）" : "标称值（存档）"}" /></div>`;
    }
    container.appendChild(card);
  }
}

function hydrateEditorFromSpec(spec) {
  for (const variable of spec.variables) {
    const definition = currentRule().variables[variable.variable];
    if (definition.kind === "categorical") {
      const select = document.querySelector(`select[data-var="${variable.variable}"]`);
      if (select) select.value = variable.text;
    } else {
      for (const source of ["nominal", "measured"]) {
        const input = document.querySelector(`input[data-var="${variable.variable}"][data-kind="${source}"]`);
        if (input) input.value = variable[source] ?? "";
      }
    }
  }
  state.editorSpec.name = spec.name;
}

function collectSpec() {
  const rule = currentRule();
  const values = new Map();
  document.querySelectorAll("#specEditor [data-var]").forEach((element) => {
    const name = element.dataset.var;
    const kind = element.dataset.kind;
    if (!values.has(name)) values.set(name, { variable: name });
    const entry = values.get(name);
    if (kind === "text") {
      entry.text = element.value;
    } else {
      const raw = element.value.trim();
      entry[kind] = raw === "" ? null : Number(raw);
      entry.unit = element.dataset.unit || null;
    }
  });
  const variables = [...values.values()].filter((v) => {
    const definition = rule.variables[v.variable];
    if (definition.kind === "interval") {
      const source = definition.productionValue;
      return typeof v[source] === "number";
    }
    return Boolean(v.text);
  });
  return { name: state.editorSpec.name, variables };
}

const BOUND_TEXT = {
  inside: "落在区间内部",
  outside: "落在区间之外",
  "lower-boundary": "恰在下界",
  "upper-boundary": "恰在上界",
};

function renderResult(result) {
  state.currentResult = result;
  const box = document.getElementById("result");
  box.hidden = false;
  const conclusion = document.getElementById("conclusion");
  conclusion.textContent = result.conclusion === "COVERED" ? "结论：已完整覆盖 ✔" : "结论：未完整覆盖 ✘";
  conclusion.className = `conclusion ${result.conclusion === "COVERED" ? "covered" : "not-covered"}`;
  document.getElementById("pkgDigest").textContent = result.packageDigest;
  document.getElementById("versionDigest").textContent = result.versionDigest;
  document.getElementById("stitchingMode").textContent =
    result.stitching === "forbidden" ? "禁止拼接 forbidden" : "允许拼接 permitted";

  const list = document.getElementById("variableList");
  list.innerHTML = "";
  for (const assessment of result.variables) {
    const card = document.createElement("div");
    card.className = `var-card ${assessment.status}`;
    const productionText =
      assessment.kind === "interval"
        ? `${assessment.productionValue ?? "—"} ${assessment.unit ?? ""}`
        : String(assessment.productionValue ?? "—");
    let evidenceHtml = "";
    if (assessment.evidence.length > 0) {
      evidenceHtml = assessment.evidence
        .map((evidence) => {
          if (assessment.kind === "categorical") {
            return `<div>试件 <b>${evidence.code}</b> 取值 ${evidence.couponValue}（精确匹配）</div>`;
          }
          const lowerText = evidence.lower === null ? "-∞" : `${evidence.lowerBound === "closed" ? "[" : "("}${evidence.lower.toFixed(3)}`;
          const upperText = evidence.upper === null ? "+∞" : `${evidence.upper.toFixed(3)}${evidence.upperBound === "closed" ? "]" : ")"}`;
          return `<div>试件 <b>${evidence.code}</b> ${evidence.couponValueSource}值 ${evidence.couponValue} → 覆盖区间 ${lowerText}, ${upperText}，${BOUND_TEXT[evidence.boundary]}</div>`;
        })
        .join("");
    } else {
      evidenceHtml = `<div>${assessment.gapReason ?? "无命中证据"}</div>`;
    }
    card.innerHTML = `
      <div class="var-head">
        <span><b>${label(assessment.variable)}</b>（${assessment.variable}）生产值：${productionText}</span>
        <span class="badge ${assessment.status === "covered" ? "ok" : "bad"}">${assessment.status === "covered" ? "已覆盖" : "缺口"}</span>
      </div>
      <div class="evidence">${evidenceHtml}</div>`;
    list.appendChild(card);
  }

  const groups = document.getElementById("groupList");
  groups.innerHTML = "";
  for (const group of result.groups) {
    const card = document.createElement("div");
    card.className = `group-card ${group.satisfied ? "satisfied" : "unsatisfied"}`;
    card.innerHTML = `
      <div class="var-head">
        <span><b>${group.label}</b>：${group.variables.map(label).join(" + ")}</span>
        <span class="badge ${group.satisfied ? "ok" : "bad"}">${group.satisfied ? "同一试件联合证明" : "无单一试件联合满足"}</span>
      </div>
      <div class="evidence">${group.satisfied ? `证据试件：${group.satisfiedBy.join("、")}` : "缺口：需要同一试件同时命中组内全部变量"}</div>`;
    groups.appendChild(card);
  }

  const nearestBox = document.getElementById("nearestBox");
  if (result.nearest && result.conclusion !== "COVERED") {
    const nearest = result.nearest;
    nearestBox.innerHTML = `<div class="callout nearest">
      <b>离合格最近的试验：${nearest.code}</b>（已命中 ${nearest.coveredCount} 个变量：${nearest.coveredVariables.map(label).join("、") || "无"}）
      <ul>
        ${nearest.missingEvidence.map((line) => `<li>${line}</li>`).join("")}
        ${nearest.mechanicalMissing.map((name) => `<li>缺力学合格项：${name}</li>`).join("")}
      </ul>
      <div class="muted">${nearest.note}</div>
    </div>`;
  } else {
    nearestBox.innerHTML = "";
  }

  const rejectionBox = document.getElementById("rejectionBox");
  rejectionBox.innerHTML = result.rejectionReasons.length
    ? `<div class="callout reject"><b>排除 / 拒绝原因</b><ul>${result.rejectionReasons.map((reason) => `<li>${reason}</li>`).join("")}</ul></div>`
    : "";

  drawRanges(result);
}

function drawRanges(result) {
  const canvas = document.getElementById("rangeCanvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 960 * dpr;
  canvas.height = 320 * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, 960, 320);
  ctx.fillStyle = "#171e26";
  ctx.fillRect(0, 0, 960, 320);

  const intervals = result.variables.filter((v) => v.kind === "interval");
  const rowHeight = 320 / (intervals.length + 0.5);
  ctx.font = "12px sans-serif";
  intervals.forEach((assessment, index) => {
    const y = 46 + index * rowHeight;
    const evidence = assessment.evidence;
    const production = Number(assessment.productionValue);
    let lo = Infinity;
    let hi = -Infinity;
    evidence.forEach((e) => {
      if (e.lower !== null) lo = Math.min(lo, e.lower);
      if (e.upper !== null) hi = Math.max(hi, e.upper);
    });
    lo = Number.isFinite(lo) ? lo : production - 1;
    hi = Number.isFinite(hi) ? hi : production + 1;
    const pad = (hi - lo || 1) * 0.25;
    lo -= pad;
    hi += pad;
    const xOf = (value) => 60 + ((value - lo) / (hi - lo || 1)) * 820;

    ctx.fillStyle = "#e6edf3";
    ctx.fillText(`${label(assessment.variable)} (${assessment.unit})`, 12, y - 8);
    ctx.strokeStyle = "#2b3845";
    ctx.beginPath();
    ctx.moveTo(60, y);
    ctx.lineTo(900, y);
    ctx.stroke();

    evidence.forEach((e, evidenceIndex) => {
      const x1 = e.lower === null ? 60 : xOf(e.lower);
      const x2 = e.upper === null ? 900 : xOf(e.upper);
      ctx.fillStyle = evidenceIndex % 2 === 0 ? "rgba(63,185,80,0.22)" : "rgba(77,163,255,0.22)";
      ctx.fillRect(x1, y - 12, x2 - x1, 24);
      ctx.fillStyle = "#8b9aa8";
      ctx.fillText(`${e.code} ${e.lower === null ? "" : (e.lowerBound === "closed" ? "[" : "(") + e.lower.toFixed(2)}→${e.upper === null ? "" : e.upper.toFixed(2) + (e.upperBound === "closed" ? "]" : ")")}`, x1 + 4, y - 15);
      if (e.lower !== null) {
        ctx.strokeStyle = e.lowerBound === "closed" ? "#3fb950" : "#d29922";
        ctx.beginPath();
        ctx.moveTo(x1, y - 12);
        ctx.lineTo(x1, y + 12);
        ctx.stroke();
      }
      if (e.upper !== null) {
        ctx.strokeStyle = e.upperBound === "closed" ? "#3fb950" : "#d29922";
        ctx.beginPath();
        ctx.moveTo(x2, y - 12);
        ctx.lineTo(x2, y + 12);
        ctx.stroke();
      }
    });

    if (Number.isFinite(production)) {
      const px = xOf(production);
      ctx.strokeStyle = "#f85149";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, y - 14);
      ctx.lineTo(px, y + 14);
      ctx.stroke();
      ctx.fillStyle = "#f85149";
      ctx.fillText(`生产 ${production}`, px - 18, y + 28);
      ctx.lineWidth = 1;
    }
  });
  ctx.fillStyle = "#8b9aa8";
  ctx.fillText("红竖线=生产工艺值；色块=各试件声明的覆盖区间；绿界=闭（含界），橙界=开（不含界）", 60, 306);
}

async function renderCompare() {
  const from = document.getElementById("compareFrom").value;
  const to = document.getElementById("compareTo").value;
  const data = await api(`/api/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const box = document.getElementById("compareResult");
  box.innerHTML = `
    <div class="muted" style="margin-bottom:10px">
      ${data.from.version}（${data.from.stitching}，力学：${data.from.requiredMechanical.join("/")}）
      → ${data.to.version}（${data.to.stitching}，力学：${data.to.requiredMechanical.join("/")}）
      ・规则包摘要 <code>${data.packageDigest.slice(0, 16)}…</code>
    </div>`;
  for (const change of data.changes) {
    if (change.kind !== "interval") continue;
    const row = document.createElement("div");
    row.className = "compare-row";
    const fmt = (bound) =>
      bound ? `<code>${bound.lowerExpr ?? "-∞"} ${bound.lowerBound === "open" ? "(" : "["} … ${bound.upperExpr ?? "+∞"} ${bound.upperBound === "open" ? ")" : "]"}</code>` : "—";
    const [aLo, aHi] = change.sample.fromRange;
    const [bLo, bHi] = change.sample.toRange;
    row.innerHTML = `
      <span style="width:120px"><b>${label(change.variable)}</b></span>
      <span style="width:250px">旧：${fmt(change.from)}</span>
      <span style="width:250px">新：${fmt(change.to)}</span>
      <span class="change-badge change-${change.change}">
        ${({ narrowed: "收窄", widened: "放宽", moved: "位移", unchanged: "不变", added: "新增", removed: "移除" })[change.change]}
      </span>
      <span class="muted">v=${change.sample.couponValue}：旧 [${aLo ?? "-∞"}, ${aHi ?? "+∞"}] → 新 [${bLo ?? "-∞"}, ${bHi ?? "+∞"}]</span>`;
    box.appendChild(row);
  }
  drawCompare(data);
}

function drawCompare(data) {
  const canvas = document.getElementById("compareCanvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 960 * dpr;
  canvas.height = 300 * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#171e26";
  ctx.fillRect(0, 0, 960, 300);
  ctx.font = "12px sans-serif";
  const rows = data.changes.filter((c) => c.kind === "interval");
  const rowHeight = 260 / rows.length;
  rows.forEach((change, index) => {
    const [aLo, aHi] = change.sample.fromRange;
    const [bLo, bHi] = change.sample.toRange;
    const numbers = [aLo, aHi, bLo, bHi].filter((n) => n !== null);
    let lo = Math.min(...numbers);
    let hi = Math.max(...numbers);
    const pad = (hi - lo || 1) * 0.2;
    lo -= pad;
    hi += pad;
    const xOf = (value) => 170 + ((value - lo) / (hi - lo)) * 720;
    const y1 = 36 + index * rowHeight;
    const y2 = y1 + 22;

    ctx.fillStyle = "#e6edf3";
    ctx.fillText(`${label(change.variable)}（旧）`, 20, y1 + 14);
    ctx.fillStyle = "#e6edf3";
    ctx.fillText(`${label(change.variable)}（新）`, 20, y2 + 14);

    if (aLo !== null && aHi !== null) {
      ctx.fillStyle = "rgba(77,163,255,0.25)";
      ctx.fillRect(xOf(aLo), y1, xOf(aHi) - xOf(aLo), 14);
      ctx.strokeStyle = change.from.lowerBound === "open" || change.from.upperBound === "open" ? "#d29922" : "#4da3ff";
      ctx.strokeRect(xOf(aLo), y1, xOf(aHi) - xOf(aLo), 14);
    }
    if (bLo !== null && bHi !== null) {
      ctx.fillStyle = "rgba(63,185,80,0.25)";
      ctx.fillRect(xOf(bLo), y2, xOf(bHi) - xOf(bLo), 14);
      ctx.strokeStyle = change.to.lowerBound === "open" || change.to.upperBound === "open" ? "#d29922" : "#3fb950";
      ctx.strokeRect(xOf(bLo), y2, xOf(bHi) - xOf(bLo), 14);
    }
  });
  ctx.fillStyle = "#8b9aa8";
  ctx.fillText("蓝色=旧版覆盖区间，绿色=新版覆盖区间（以 fixture 样例试件值计算）；橙色边框表示含开区间界限", 170, 284);
}

async function renderRuns() {
  const runs = await api("/api/runs");
  const body = document.getElementById("runsBody");
  body.innerHTML = "";
  for (const run of runs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${run.id}</td>
      <td>${run.createdAt}</td>
      <td>${run.version}</td>
      <td>${run.specName ?? "自定义"}</td>
      <td class="${run.conclusion === "COVERED" ? "tag-covered" : "tag-not"}">${run.conclusion === "COVERED" ? "已覆盖" : "未覆盖"}</td>
      <td><code>${run.digest.slice(0, 12)}…</code></td>
      <td><button data-run="${run.id}">查看</button></td>`;
    body.appendChild(tr);
  }
}

async function showRun(id) {
  const run = await api(`/api/runs/${id}`);
  const detail = document.getElementById("runDetail");
  detail.hidden = false;
  detail.textContent = JSON.stringify({ id: run.id, spec: run.spec, result: run.result }, null, 2);
}

function renderDataTab() {
  const couponList = document.getElementById("couponList");
  couponList.innerHTML = "";
  for (const coupon of state.coupons) {
    const card = document.createElement("div");
    const dead = coupon.status !== "valid";
    card.className = `record-card ${dead ? "dead" : ""}`;
    const vars = coupon.variables
      .map((v) => {
        if (v.text) return `${label(v.variable)}=${v.text}`;
        const parts = [];
        if (v.nominal !== null && v.nominal !== undefined) parts.push(`标称${v.nominal}`);
        if (v.measured !== null && v.measured !== undefined) parts.push(`实测${v.measured}`);
        return `${label(v.variable)} ${parts.join("/")}${v.unit ? " " + v.unit : " <span class='tag-not'>单位不明</span>"}`;
      })
      .join("　");
    const mechanics = coupon.mechanical
      .map((m) => `${m.testType}:${m.result === "pass" ? "合格" : "不合格"}`)
      .join(" / ");
    card.innerHTML = `
      <h4>${coupon.code}<span class="pill ${coupon.status}">${({ valid: "有效", expired: "已过期", withdrawn: "已撤销" })[coupon.status]}</span></h4>
      <div class="kv"><span>${vars}</span></div>
      <div class="kv"><span>力学：<b>${mechanics || "无记录"}</b></span><span>${coupon.note ?? ""}</span></div>`;
    couponList.appendChild(card);
  }

  const specList = document.getElementById("specList");
  specList.innerHTML = "";
  for (const spec of state.specs) {
    const card = document.createElement("div");
    card.className = "record-card";
    const vars = spec.variables
      .map((v) => {
        if (v.text) return `${label(v.variable)}=${v.text}`;
        const rule = state.versions[0]?.variables[v.variable];
        const used = rule?.kind === "interval" ? rule.productionValue : null;
        return `${label(v.variable)}=${v[used] ?? v.nominal ?? v.measured}${v.unit ? " " + v.unit : ""}`;
      })
      .join("　");
    card.innerHTML = `<h4>${spec.name}</h4><div class="kv"><span>${vars}</span></div>`;
    specList.appendChild(card);
  }
}

async function doEvaluate() {
  const specId = document.getElementById("specSelect").value;
  const payload = specId
    ? { version: document.getElementById("versionSelect").value, spec: { id: Number(specId) } }
    : { version: document.getElementById("versionSelect").value, spec: collectSpec() };
  try {
    const result = await api("/api/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    renderResult(result);
    renderRuns();
  } catch (error) {
    alert(`核对失败：${error.message}`);
  }
}

async function exportBundle() {
  const data = await api("/api/export");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `witness-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  document.getElementById("ioStatus").textContent = "已导出（含规则包、试件、工艺与全部运行记录）";
}

function importBundle(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const bundle = JSON.parse(reader.result);
      await api("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bundle),
      });
      document.getElementById("ioStatus").textContent = "导入完成，可重新核对复核";
      await bootstrap();
      await renderRuns();
    } catch (error) {
      alert(`导入失败：${error.message}`);
    }
  };
  reader.readAsText(file);
}

async function replay() {
  if (!confirm("将清空当前数据库并从固定 fixture 重放，确定继续？")) return;
  await api("/api/replay", { method: "POST" });
  document.getElementById("ioStatus").textContent = "已清空并重放固定 fixture";
  await bootstrap();
  await renderRuns();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "runs") renderRuns();
    if (tab.dataset.tab === "data") renderDataTab();
  });
});

document.getElementById("versionSelect").addEventListener("change", renderEditor);
document.getElementById("specSelect").addEventListener("change", () => {
  const specId = document.getElementById("specSelect").value;
  if (specId) {
    const spec = state.specs.find((candidate) => candidate.id === Number(specId));
    renderEditor();
    hydrateEditorFromSpec(spec);
  } else {
    renderEditor();
  }
});
document.getElementById("evaluateBtn").addEventListener("click", doEvaluate);
document.getElementById("compareBtn").addEventListener("click", renderCompare);
document.getElementById("refreshRuns").addEventListener("click", renderRuns);
document.getElementById("runsBody").addEventListener("click", (event) => {
  const button = event.target.closest("[data-run]");
  if (button) showRun(button.dataset.run);
});
document.getElementById("exportBtn").addEventListener("click", exportBundle);
document.getElementById("importFile").addEventListener("change", (event) => {
  if (event.target.files[0]) importBundle(event.target.files[0]);
});
document.getElementById("replayBtn").addEventListener("click", replay);
document.getElementById("refreshData").addEventListener("click", renderDataTab);

bootstrap().catch((error) => {
  document.getElementById("packageMeta").textContent = `初始化失败：${error.message}`;
});
