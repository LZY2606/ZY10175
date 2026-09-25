const $ = (sel) => document.querySelector(sel);
const state = { rules: [], records: [], production: null, lastResult: null, lastCompare: null };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function fmtVal(v) {
  return Array.isArray(v) ? v.join("、") : String(v);
}

function fmtInterval(iv, unit) {
  if (!iv) return "—";
  const l = iv.lower === null ? "-∞" : String(Math.round(iv.lower * 1e6) / 1e6);
  const u = iv.upper === null ? "+∞" : String(Math.round(iv.upper * 1e6) / 1e6);
  return `${iv.lowerBound === "closed" ? "[" : "("}${l}, ${u}${iv.upperBound === "closed" ? "]" : ")"}${unit ? " " + unit : ""}`;
}

async function loadState() {
  const data = await api("/api/state");
  Object.assign(state, data);
  renderRuleSelects();
  renderProductionForm();
  renderRuns();
}

function renderRuleSelects() {
  for (const id of ["#rule-version", "#rule-version-b"]) {
    const sel = $(id);
    const keepEmpty = id === "#rule-version-b";
    sel.innerHTML = keepEmpty ? '<option value="">（不对比）</option>' : "";
    for (const r of state.rules) {
      const opt = document.createElement("option");
      opt.value = r.version;
      opt.textContent = `${r.version}（摘要 ${r.digest.slice(0, 12)}…）`;
      sel.appendChild(opt);
    }
  }
  $("#rule-version").value = state.rules[state.rules.length - 1]?.version ?? "";
  if (!$("#as-of").value) $("#as-of").value = new Date().toISOString().slice(0, 10);
}

function renderProductionForm() {
  const form = $("#production-form");
  form.innerHTML = "";
  const vars = state.rules[0]?.variables ?? [];
  for (const v of vars) {
    const label = document.createElement("label");
    label.textContent = `${v.label}${v.unit ? `（${v.unit}）` : ""}`;
    const input = document.createElement("input");
    input.dataset.key = v.key;
    input.dataset.kind = v.kind;
    const val = state.production?.values?.[v.key];
    input.value = v.kind === "enum-set" ? (val ?? []).join(",") : (val ?? "");
    label.appendChild(input);
    form.appendChild(label);
  }
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "工艺名称";
  const nameInput = document.createElement("input");
  nameInput.id = "production-name";
  nameInput.value = state.production?.name ?? "";
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);
}

function readProduction() {
  const values = {};
  for (const input of document.querySelectorAll("#production-form input[data-key]")) {
    const { key, kind } = input.dataset;
    if (kind === "number") values[key] = Number(input.value);
    else if (kind === "enum-set") values[key] = input.value.split(",").map((s) => s.trim()).filter(Boolean);
    else values[key] = input.value.trim();
  }
  return { name: $("#production-name").value || "未命名工艺", values };
}

function renderResult(result) {
  state.lastResult = result;
  $("#conclusion-panel").hidden = false;
  const ok = result.conclusion === "covered";
  $("#conclusion").innerHTML = `
    <div class="big">${ok ? "✅ 完整覆盖" : "❌ 未完整覆盖"}</div>
    <div>规则版本 <span class="mono">${result.ruleVersion}</span> ·
      规则包摘要 <span class="mono">${result.ruleDigest}</span></div>
    <div class="muted">核查基准日 ${result.asOf} · 结论已按规则包摘要固定，可随运行记录导出复核。</div>`;

  const prod = readProduction();
  const tbody = $("#variables-table tbody");
  tbody.innerHTML = "";
  for (const v of result.variables) {
    const tr = document.createElement("tr");
    const ev = v.evidence.map((e) =>
      `<div class="evidence">✔ ${e.recordId} / ${e.pieceId}<br><span class="muted">${e.detail}</span></div>`).join("");
    const gap = v.gap
      ? `<div class="gap">✘ ${v.gap.reason}</div>` +
        (v.gap.nearest
          ? `<div class="nearest">最接近：${v.gap.nearest.recordId} / ${v.gap.nearest.pieceId}（距离 ${v.gap.nearest.distance}）<br>${v.gap.nearest.missing}</div>`
          : "")
      : "";
    tr.innerHTML = `
      <td>${v.label}${v.viaGroup ? `<br><span class="muted mono">联合组 ${v.viaGroup}</span>` : ""}</td>
      <td class="mono">${fmtVal(prod.values[v.key] ?? "—")}</td>
      <td><span class="badge ${v.covered ? "ok" : "bad"}">${v.covered ? "已覆盖" : "缺口"}</span></td>
      <td>${ev || '<span class="muted">—</span>'}</td>
      <td>${gap || '<span class="muted">—</span>'}</td>`;
    tbody.appendChild(tr);
  }
  $("#variables-panel").hidden = false;

  const groups = $("#groups");
  groups.innerHTML = "";
  for (const g of result.groups) {
    const div = document.createElement("div");
    div.className = "group-card";
    div.innerHTML = `
      <span class="badge ${g.satisfied ? "ok" : "bad"}">${g.satisfied ? "联合证明成立" : "联合证明不成立"}</span>
      <strong>${g.label}</strong>
      ${g.satisfied
        ? `<div class="evidence">由同一试件 ${g.recordId} / ${g.pieceId} 联合证明</div>`
        : `<div class="gap">仍缺：${g.missing.join("；")}</div>`}`;
    groups.appendChild(div);
  }
  $("#groups-panel").hidden = result.groups.length === 0;

  const ex = $("#excluded");
  ex.innerHTML = "";
  for (const e of result.excludedRecords) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="mono">${e.recordId}</span>：${e.reasons.join("；")}`;
    ex.appendChild(li);
  }
  $("#excluded-panel").hidden = result.excludedRecords.length === 0;
}

function renderCompare(data) {
  state.lastCompare = data;
  $("#compare-panel").hidden = false;
  $("#cmp-ha").textContent = `v${data.a.ruleVersion}`;
  $("#cmp-hb").textContent = `v${data.b.ruleVersion}`;
  const tbody = $("#compare-table tbody");
  tbody.innerHTML = "";
  for (const d of data.diff) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${d.label}</td>
      <td><span class="badge ${d.aCovered ? "ok" : "bad"}">${d.aCovered ? "覆盖" : "缺口"}</span>
        <div class="mono muted">${fmtInterval(d.aInterval)}</div></td>
      <td><span class="badge ${d.bCovered ? "ok" : "bad"}">${d.bCovered ? "覆盖" : "缺口"}</span>
        <div class="mono muted">${fmtInterval(d.bInterval)}</div></td>
      <td>${d.changed ? '<span class="badge warn">范围变化</span>' : '<span class="muted">无变化</span>'}</td>`;
    tbody.appendChild(tr);
  }
}

function renderRuns() {
  const tbody = $("#runs-table tbody");
  tbody.innerHTML = "";
  for (const run of state.runs ?? []) {
    const tr = document.createElement("tr");
    const conclusion = run.kind === "check"
      ? (run.result.conclusion === "covered" ? "完整覆盖" : "未完整覆盖")
      : "版本对比";
    tr.innerHTML = `
      <td class="mono">${run.id}</td>
      <td class="mono">${run.createdAt}</td>
      <td>${run.kind === "check" ? "核查" : "对比"}</td>
      <td class="mono">${run.ruleVersion}</td>
      <td class="mono">${run.ruleDigest.slice(0, 16)}…</td>
      <td>${conclusion}</td>`;
    tbody.appendChild(tr);
  }
}

/* ---------- Canvas 区间图 ---------- */

async function drawChart() {
  const version = $("#rule-version").value;
  const versionB = $("#rule-version-b").value;
  const asOf = $("#as-of").value;
  const prod = readProduction();
  const datasets = [await api(`/api/intervals?version=${encodeURIComponent(version)}&asOf=${asOf}`)];
  if (versionB) datasets.push(await api(`/api/intervals?version=${encodeURIComponent(versionB)}&asOf=${asOf}`));

  const canvas = $("#chart");
  const ctx = canvas.getContext("2d");
  const numericVars = datasets[0].variables;
  const rowH = 34, groupGap = 16, leftPad = 130, rightPad = 40, topPad = 30;
  const rowsPerVar = datasets.length;
  const height = topPad + numericVars.length * (rowsPerVar * rowH + groupGap) + 20;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 1100 * dpr;
  canvas.height = height * dpr;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, 1100, height);
  ctx.font = "12px sans-serif";

  let y = topPad;
  for (const v of numericVars) {
    const target = Number(prod.values[v.variable]);
    // 汇总所有数据集的区间以决定坐标范围
    const allPieces = datasets.flatMap((ds) => ds.variables.find((x) => x.variable === v.variable)?.pieces ?? []);
    const nums = allPieces.flatMap((p) => [p.interval.lower, p.interval.upper]).filter((x) => x !== null);
    if (Number.isFinite(target)) nums.push(target);
    let lo = Math.min(...nums), hi = Math.max(...nums);
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.15 || 1;
    lo -= pad; hi += pad;
    const x = (val) => leftPad + ((val - lo) / (hi - lo)) * (1100 - leftPad - rightPad);

    ctx.fillStyle = "#9fc3e8";
    ctx.fillText(`${v.label}${v.unit ? ` (${v.unit})` : ""}`, 8, y + rowH / 2 + 4);

    datasets.forEach((ds, di) => {
      const rowY = y + di * rowH;
      const varData = ds.variables.find((x) => x.variable === v.variable);
      ctx.fillStyle = "#5b6b7d";
      ctx.fillText(`v${ds.version}`, leftPad - 42, rowY + rowH / 2 + 4);
      ctx.strokeStyle = "#26303c";
      ctx.beginPath(); ctx.moveTo(leftPad, rowY + rowH / 2); ctx.lineTo(1100 - rightPad, rowY + rowH / 2); ctx.stroke();

      for (const p of varData?.pieces ?? []) {
        const iv = p.interval;
        const x1 = iv.lower === null ? leftPad : x(iv.lower);
        const x2 = iv.upper === null ? 1100 - rightPad : x(iv.upper);
        const covered = Number.isFinite(target) &&
          (iv.lower === null || target > iv.lower || (target === iv.lower && iv.lowerBound === "closed")) &&
          (iv.upper === null || target < iv.upper || (target === iv.upper && iv.upperBound === "closed"));
        ctx.fillStyle = covered ? "rgba(91,216,138,0.35)" : "rgba(143,161,181,0.25)";
        ctx.fillRect(x1, rowY + 8, x2 - x1, rowH - 16);
        ctx.strokeStyle = covered ? "#5bd88a" : "#5b6b7d";
        ctx.strokeRect(x1, rowY + 8, x2 - x1, rowH - 16);
        // 端点：实心=闭区间，空心=开区间
        for (const [ex, bound] of [[x1, iv.lowerBound], [x2, iv.upperBound]]) {
          ctx.beginPath();
          ctx.arc(ex, rowY + rowH / 2, 4, 0, Math.PI * 2);
          if (bound === "closed") { ctx.fillStyle = "#dfe6ee"; ctx.fill(); }
          else { ctx.strokeStyle = "#dfe6ee"; ctx.stroke(); }
        }
        ctx.fillStyle = "#8fa1b5";
        ctx.fillText(p.recordId, x1 + 3, rowY + rowH - 8);
      }

      if (Number.isFinite(target)) {
        ctx.strokeStyle = "#ff8a94";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x(target), rowY + 2); ctx.lineTo(x(target), rowY + rowH - 2); ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = "#ff8a94";
        ctx.fillText(String(target), x(target) + 4, rowY + 12);
      }
    });
    y += rowsPerVar * rowH + groupGap;
  }
}

/* ---------- 事件 ---------- */

$("#btn-check").addEventListener("click", async () => {
  const result = await api("/api/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ production: readProduction(), ruleVersion: $("#rule-version").value, asOf: $("#as-of").value }),
  });
  $("#compare-panel").hidden = true;
  renderResult(result);
  await drawChart();
  const fresh = await api("/api/state");
  state.runs = fresh.runs;
  renderRuns();
});

$("#btn-compare").addEventListener("click", async () => {
  const a = $("#rule-version").value, b = $("#rule-version-b").value;
  if (!b) { alert("请先选择对比版本"); return; }
  const result = await api("/api/compare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ production: readProduction(), versions: [a, b], asOf: $("#as-of").value }),
  });
  renderResult(result.b);
  renderCompare(result);
  await drawChart();
  const fresh = await api("/api/state");
  state.runs = fresh.runs;
  renderRuns();
});

$("#btn-export").addEventListener("click", () => { window.location.href = "/api/export"; });

$("#btn-reset").addEventListener("click", async () => {
  if (!confirm("确认清空数据库并重新导入固定 fixture？")) return;
  await api("/api/reset", { method: "POST" });
  await loadState();
  for (const id of ["#conclusion-panel", "#variables-panel", "#groups-panel", "#excluded-panel", "#compare-panel"]) {
    $(id).hidden = true;
  }
  await drawChart();
});

loadState().then(drawChart).catch((e) => alert(`初始化失败: ${e.message}`));
