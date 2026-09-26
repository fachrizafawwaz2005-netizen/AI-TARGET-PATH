(function () {
  "use strict";

  const STAGE_LABELS = {
    disease_search: "Resolving disease (Open Targets)...",
    target_retrieval: "Finding disease-associated targets (Open Targets)...",
    target_mapping_and_bioactivity: "Running Greedy Best-First Search (ChEMBL target mapping + bioactivity)...",
    done: "Ranking candidates...",
  };
  const STAGE_ORDER = ["disease_search", "target_retrieval", "target_mapping_and_bioactivity", "done"];
  const STAGE_SOURCE = {
    disease_search: "Open Targets",
    target_retrieval: "Open Targets",
    target_mapping_and_bioactivity: "ChEMBL",
    input: "Input",
  };

  const state = {
    w1: 0.5,
    nTarget: 15,
    nCompoundPerTarget: 8,
    includeKd: false,
    result: null,
    lastQuery: null, // { mode: 'live', disease } | { mode:'live-explicit', explicitDisease } | { mode:'demo' }
    graphStep: 0,
    playing: false,
    playTimer: null,
    currentGraph: null,
  };

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------
  // Page navigation
  // ---------------------------------------------------------------------
  $("start-btn").addEventListener("click", () => showPage("exploration"));
  $("brand-btn").addEventListener("click", () => showPage("home"));

  function showPage(page) {
    $("page-home").style.display = page === "home" ? "" : "none";
    $("page-exploration").style.display = page === "exploration" ? "" : "none";
  }

  // ---------------------------------------------------------------------
  // Loader
  // ---------------------------------------------------------------------
  function buildLoader() {
    const ul = $("loader-steps");
    ul.innerHTML = "";
    STAGE_ORDER.forEach((key) => {
      const li = document.createElement("li");
      li.dataset.stage = key;
      li.innerHTML = `<span class="step-dot">•</span><span>${STAGE_LABELS[key]}</span>`;
      ul.appendChild(li);
    });
  }

  function setLoaderStage(stageKey) {
    const idx = STAGE_ORDER.indexOf(stageKey);
    const items = $("loader-steps").children;
    for (let i = 0; i < items.length; i++) {
      const li = items[i];
      const dot = li.querySelector(".step-dot");
      li.classList.remove("active", "done");
      dot.classList.remove("active", "done");
      if (i < idx) {
        li.classList.add("done");
        dot.classList.add("done");
        dot.textContent = "✓";
      } else if (i === idx) {
        li.classList.add("active");
        dot.classList.add("active");
        dot.textContent = String(i + 1);
      } else {
        dot.textContent = String(i + 1);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Config controls (single algorithm: GBFS — no selector needed)
  // ---------------------------------------------------------------------
  $("w1-slider").addEventListener("input", (e) => {
    state.w1 = parseFloat(e.target.value);
    const w2 = +(1 - state.w1).toFixed(2);
    $("w1-value").textContent = state.w1.toFixed(2);
    $("w2-value").textContent = w2.toFixed(2);
    $("w2-slider").value = w2;
    updateFormulaBox();
  });

  $("ntarget-slider").addEventListener("input", (e) => {
    state.nTarget = parseInt(e.target.value, 10);
    $("ntarget-value").textContent = String(state.nTarget);
  });
  $("ncompound-slider").addEventListener("input", (e) => {
    state.nCompoundPerTarget = parseInt(e.target.value, 10);
    $("ncompound-value").textContent = String(state.nCompoundPerTarget);
  });
  $("include-kd").addEventListener("change", (e) => {
    state.includeKd = e.target.checked;
  });

  function updateFormulaBox() {
    const w2 = +(1 - state.w1).toFixed(2);
    $("formula-box").textContent = `h = ${state.w1.toFixed(2)} × target_association_score + ${w2.toFixed(2)} × (pActivity / 12)`;
  }
  updateFormulaBox();

  // ---------------------------------------------------------------------
  // Run exploration (live) / run demo (explicit, separate)
  // ---------------------------------------------------------------------
  $("run-btn").addEventListener("click", () => {
    const disease = $("disease-input").value.trim();
    if (!disease) return;
    runLive({ disease });
  });
  $("rerun-btn").addEventListener("click", () => {
    if (!state.lastQuery) return;
    if (state.lastQuery.mode === "demo") runDemo();
    else if (state.lastQuery.mode === "live-explicit") runLive({ explicitDisease: state.lastQuery.explicitDisease });
    else runLive({ disease: state.lastQuery.disease });
  });
  $("disease-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("run-btn").click();
  });
  $("demo-btn").addEventListener("click", runDemo);

  function beginRun() {
    $("run-btn").disabled = true;
    $("rerun-btn").disabled = true;
    $("demo-btn").disabled = true;
    $("error-box").style.display = "none";
    $("disease-picker").style.display = "none";
    $("demo-box").style.display = "none";
    $("results").style.display = "none";
    buildLoader();
    $("loader-card").style.display = "";
  }

  function endRun() {
    $("loader-card").style.display = "none";
    $("run-btn").disabled = false;
    $("rerun-btn").disabled = false;
    $("demo-btn").disabled = false;
  }

  async function runLive({ disease, explicitDisease }) {
    beginRun();
    try {
      const result = await TP.explore({
        disease,
        explicitDisease: explicitDisease || null,
        nTarget: state.nTarget,
        nCompoundPerTarget: state.nCompoundPerTarget,
        w1: state.w1,
        includeKd: state.includeKd,
        onStep: (stage) => setLoaderStage(stage),
      });
      state.lastQuery = explicitDisease ? { mode: "live-explicit", explicitDisease } : { mode: "live", disease };
      state.result = result;
      renderResult(result);
    } catch (e) {
      if (e.ambiguous) {
        showDiseasePicker(disease, e.candidates);
      } else {
        showError(e);
      }
    } finally {
      endRun();
    }
  }

  async function runDemo() {
    beginRun();
    try {
      const result = await TP.runDemoExplore({ w1: state.w1, includeKd: state.includeKd });
      state.lastQuery = { mode: "demo" };
      state.result = result;
      renderResult(result);
    } catch (e) {
      showError(e);
    } finally {
      endRun();
    }
  }

  function showError(e) {
    const source = STAGE_SOURCE[e.stage] || "Application";
    const box = $("error-box");
    box.innerHTML = `<strong>${escapeHtml(source)} error${e.stage ? ` (stage: ${escapeHtml(e.stage)})` : ""}:</strong> ${escapeHtml(e.message || "Something went wrong.")}`;
    box.style.display = "";
  }

  function showDiseasePicker(originalQuery, candidates) {
    const box = $("disease-picker");
    box.innerHTML = `<div class="picker-title">Multiple diseases matched "${escapeHtml(originalQuery)}" — choose the one you meant:</div>`;
    const list = document.createElement("div");
    list.className = "picker-list";
    candidates.forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "btn-outline picker-btn";
      btn.innerHTML = `<strong>${escapeHtml(c.name)}</strong><span class="mono muted"> ${escapeHtml(c.id)}</span>`;
      btn.addEventListener("click", () => runLive({ explicitDisease: { id: c.id, name: c.name } }));
      list.appendChild(btn);
    });
    box.appendChild(list);
    box.style.display = "";
  }

  // ---------------------------------------------------------------------
  // Render full result
  // ---------------------------------------------------------------------
  function renderResult(result) {
    if (result.demoMode) {
      $("demo-box").innerHTML = `<strong>DEMO MODE — not live data.</strong> ${escapeHtml(result.demoReason || "")}`;
      $("demo-box").style.display = "";
    }

    $("disease-name").textContent = result.disease.name;
    $("disease-id").textContent = result.disease.id;
    $("disease-source").textContent = `Source: ${result.disease.source}${result.demoMode ? " — DEMO" : " — LIVE"}`;

    if (result.emptyReason) {
      $("targets-tbody").innerHTML = "";
      $("candidates-tbody").innerHTML = "";
      $("empty-state").textContent = result.emptyReason;
      $("empty-state").style.display = "";
    } else {
      $("empty-state").style.display = "none";
    }

    renderSummaryStats(result);
    renderTargets(result);
    renderSkipped(result.skippedTargets || []);
    renderExcluded(result.excludedRecords || []);
    renderGraph(result);
    renderExplorationLog(result.log || [], result.nodes || []);
    renderCandidates(result.candidates || []);
    renderChart(result.candidates || []);

    $("results").style.display = "";
  }

  function renderSummaryStats(result) {
    const s = result.stats || {};
    $("summary-stats").innerHTML = `
      <div class="stat-chip"><span class="stat-num">${s.targetsChecked ?? 0}</span><span>targets checked</span></div>
      <div class="stat-chip"><span class="stat-num">${s.targetsMapped ?? 0}</span><span>mapped to ChEMBL</span></div>
      <div class="stat-chip"><span class="stat-num">${s.compoundRecordsConsidered ?? 0}</span><span>bioactivity records examined</span></div>
      <div class="stat-chip"><span class="stat-num">${s.compoundsPassedFilter ?? 0}</span><span>passed quality filter</span></div>
      <div class="stat-chip"><span class="stat-num">${s.recordsExcluded ?? 0}</span><span>excluded (reasons below)</span></div>
    `;
  }

  function renderTargets(result) {
    const compoundCountBySymbol = {};
    (result.candidates || []).forEach((c) => {
      compoundCountBySymbol[c.targetSymbol] = (compoundCountBySymbol[c.targetSymbol] || 0) + 1;
    });
    const skippedBySymbol = {};
    (result.skippedTargets || []).forEach((s) => (skippedBySymbol[s.symbol] = s.reason));

    const tbody = $("targets-tbody");
    tbody.innerHTML = "";
    (result.targets || []).forEach((t, i) => {
      const tr = document.createElement("tr");
      const skipReason = skippedBySymbol[t.symbol];
      const mappingCell = skipReason
        ? `<span class="not-available" title="${escapeHtml(skipReason)}">Skipped</span>`
        : (compoundCountBySymbol[t.symbol] ? '<span class="mono">mapped</span>' : '<span class="not-available">mapped, no results</span>');
      tr.innerHTML = `
        <td class="muted">${i + 1}</td>
        <td><strong>${escapeHtml(t.symbol || "—")}</strong></td>
        <td>${escapeHtml(t.name || "—")}</td>
        <td class="mono">${(t.targetScore ?? 0).toFixed(3)}</td>
        <td>${mappingCell}</td>
        <td>${compoundCountBySymbol[t.symbol] || 0}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderSkipped(skipped) {
    const card = $("skipped-card");
    if (!skipped.length) {
      card.style.display = "none";
      return;
    }
    card.style.display = "";
    $("skipped-list").innerHTML = skipped
      .map((s) => `<li><strong>${escapeHtml(s.symbol)}</strong> <span class="muted">(${escapeHtml(s.name || "")})</span> — ${escapeHtml(s.reason)}</li>`)
      .join("");
  }

  function renderExcluded(excluded) {
    const card = $("excluded-card");
    if (!excluded.length) {
      card.style.display = "none";
      return;
    }
    card.style.display = "";
    const shown = excluded.slice(0, 25);
    $("excluded-list").innerHTML = shown
      .map((e) => `<li><span class="mono">${escapeHtml(e.moleculeId || "?")}</span> <span class="muted">(${escapeHtml(e.targetSymbol || "")})</span> — ${escapeHtml(e.reason)}</li>`)
      .join("");
    $("excluded-more").textContent = excluded.length > shown.length ? `+ ${excluded.length - shown.length} more excluded record(s) not shown.` : "";
  }

  function renderCandidates(candidates) {
    const tbody = $("candidates-tbody");
    tbody.innerHTML = "";
    candidates.forEach((c) => {
      const tr = document.createElement("tr");
      tr.className = "clickable";
      tr.innerHTML = `
        <td><strong>#${c.rank}</strong></td>
        <td class="mono" style="color:#4f46e5">${escapeHtml(c.compoundId)}</td>
        <td>${escapeHtml(c.targetSymbol)}</td>
        <td>${escapeHtml(c.activityType)}${c.pchemblProvided ? "" : '<span class="muted" title="pActivity derived from value+unit, not a ChEMBL-provided pChEMBL value"> *</span>'}</td>
        <td class="mono">${c.valueNM} nM</td>
        <td class="mono">${c.pActivity}</td>
        <td class="mono">${c.targetScore.toFixed(3)}</td>
        <td class="mono"><strong>${c.heuristicScore.toFixed(4)}</strong></td>
      `;
      tr.addEventListener("click", () => openModal(c));
      tbody.appendChild(tr);
    });
  }

  // ---------------------------------------------------------------------
  // Exploration log (textual GBFS trace — what was explored, in what order,
  // and why, including failed goal tests)
  // ---------------------------------------------------------------------
  function renderExplorationLog(log, nodes) {
    const nodeById = {};
    nodes.forEach((n) => (nodeById[n.id] = n));
    const list = $("gbfs-log");
    list.innerHTML = log
      .map((l) => {
        const failed = /FAILED/.test(l.action || "");
        const cls = failed ? "log-item failed" : "log-item";
        return `<li class="${cls}"><span class="log-step">#${l.step}</span><span class="log-kind">${l.kind}</span><span class="mono log-label">${escapeHtml(l.label)}</span><span class="mono log-h">h=${l.heuristic}</span><span class="log-action">${escapeHtml(l.action || "")}</span></li>`;
      })
      .join("");
  }

  // ---------------------------------------------------------------------
  // Search graph (bubble diagram) — driven by exploredOrder from GBFS log
  // ---------------------------------------------------------------------
  function renderGraph(result) {
    stopPlaying();
    const order = result.exploredOrder || [];
    const search = { algorithm: result.algorithm, order, nodesExplored: (result.log || []).length };
    state.graphStep = order.length;

    $("search-stats").innerHTML = `
      <span class="pill">${escapeHtml(search.algorithm)}</span>
      <span>Nodes explored: ${search.nodesExplored}</span>
      <span>Goals found: ${(result.candidates || []).length}</span>
    `;

    const graph = { nodes: result.nodes || [], edges: result.edges || [] };
    const disease = graph.nodes.find((n) => n.type === "disease");
    const targets = graph.nodes.filter((n) => n.type === "target");
    const nodeById = {};
    graph.nodes.forEach((n) => (nodeById[n.id] = n));
    const compoundsByTarget = {};
    targets.forEach((t) => {
      compoundsByTarget[t.id] = graph.edges.filter((e) => e.from === t.id).map((e) => e.to);
    });

    const diseaseRow = $("graph-disease-row");
    diseaseRow.innerHTML = "";
    if (disease) diseaseRow.appendChild(makeNodeBubble(disease.id, disease.label, "disease", disease.label));

    const targetsRow = $("graph-targets-row");
    targetsRow.innerHTML = "";
    targetsRow.style.gridTemplateColumns = `repeat(${targets.length || 1}, minmax(120px, 1fr))`;

    targets.forEach((t) => {
      const col = document.createElement("div");
      col.className = "target-col";
      const targetLabel = `${t.name || ""} — association score ${(t.targetScore ?? 0).toFixed(3)}`;
      col.appendChild(makeNodeBubble(t.id, t.label, "target", targetLabel));

      const wrap = document.createElement("div");
      wrap.className = "compound-wrap";
      (compoundsByTarget[t.id] || []).forEach((cid) => {
        const c = nodeById[cid];
        if (!c) return;
        const bubble = makeNodeBubble(cid, c.label.replace("CHEMBL", ""), "compound", `${c.label} — ${c.smiles || ""}`);
        bubble.addEventListener("click", () => {
          const cand = (state.result.candidates || []).find((cc) => cc.compoundId === c.label);
          if (cand) openModal(cand);
        });
        wrap.appendChild(bubble);
      });
      col.appendChild(wrap);
      targetsRow.appendChild(col);
    });

    state.currentGraph = { graph, search, nodeById };

    requestAnimationFrame(() => {
      redrawGraphHighlight();
    });

    $("step-slider").max = String(order.length);
    $("step-slider").value = String(state.graphStep);
    updateStepLabel();

    window.addEventListener("resize", debounce(redrawGraphHighlight, 150));
  }

  function makeNodeBubble(id, label, type, title) {
    const el = document.createElement("div");
    el.className = `node-bubble ${type}`;
    el.dataset.nodeId = id;
    el.title = title || label;
    el.innerHTML = `<span>${escapeHtml(label)}</span>`;
    return el;
  }

  function redrawGraphHighlight() {
    const ctx = state.currentGraph;
    if (!ctx) return;
    const { graph, search } = ctx;
    const container = $("graph-container");
    const svg = $("graph-svg");
    const cRect = container.getBoundingClientRect();

    const visited = new Set(search.order.slice(0, state.graphStep));
    const currentId = state.graphStep > 0 ? search.order[state.graphStep - 1] : null;

    container.querySelectorAll(".node-bubble").forEach((el) => {
      const id = el.dataset.nodeId;
      el.classList.toggle("visited", visited.has(id));
      el.classList.toggle("current", id === currentId);
    });

    const positions = {};
    container.querySelectorAll(".node-bubble").forEach((el) => {
      const r = el.getBoundingClientRect();
      positions[el.dataset.nodeId] = { x: r.left + r.width / 2 - cRect.left, y: r.top + r.height / 2 - cRect.top };
    });

    svg.setAttribute("width", cRect.width);
    svg.setAttribute("height", cRect.height);
    let linesHtml = "";
    graph.edges.forEach((e) => {
      const p1 = positions[e.from];
      const p2 = positions[e.to];
      if (!p1 || !p2) return;
      const on = visited.has(e.from) && visited.has(e.to);
      linesHtml += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${on ? "#6366f1" : "#e2e8f0"}" stroke-width="${on ? 2 : 1}" />`;
    });
    svg.innerHTML = linesHtml;

    updateOrderTrace();
  }

  function updateStepLabel() {
    const total = state.currentGraph ? state.currentGraph.search.order.length : 0;
    $("step-label").textContent = `${state.graphStep}/${total}`;
  }

  function updateOrderTrace() {
    const ctx = state.currentGraph;
    if (!ctx) return;
    const { search, nodeById } = ctx;
    const labels = search.order.slice(0, state.graphStep).map((id) => (nodeById[id] ? nodeById[id].label : id));
    $("order-trace").innerHTML = `<span class="lbl">Exploration order: </span><span class="mono">${escapeHtml(labels.join(" → "))}</span>`;
  }

  $("step-slider").addEventListener("input", (e) => {
    stopPlaying();
    state.graphStep = parseInt(e.target.value, 10);
    redrawGraphHighlight();
    updateStepLabel();
  });

  $("play-btn").addEventListener("click", () => {
    if (state.playing) stopPlaying();
    else startPlaying();
  });

  function startPlaying() {
    if (!state.currentGraph) return;
    const total = state.currentGraph.search.order.length;
    if (state.graphStep >= total) state.graphStep = 0;
    state.playing = true;
    $("play-btn").textContent = "Pause";
    state.playTimer = setInterval(() => {
      state.graphStep += 1;
      redrawGraphHighlight();
      updateStepLabel();
      $("step-slider").value = String(state.graphStep);
      if (state.graphStep >= total) stopPlaying();
    }, 500);
  }

  function stopPlaying() {
    state.playing = false;
    $("play-btn").textContent = "Play";
    if (state.playTimer) {
      clearInterval(state.playTimer);
      state.playTimer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Comparison chart (plain SVG bar chart, no external library)
  // ---------------------------------------------------------------------
  function renderChart(candidates) {
    const top = candidates.slice(0, 8);
    const svg = $("chart-svg");
    if (top.length < 2) {
      $("chart-card").style.display = "none";
      return;
    }
    $("chart-card").style.display = "";

    const width = svg.parentElement.clientWidth || 700;
    const height = 300;
    const margin = { top: 20, right: 10, bottom: 60, left: 40 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const groupCount = top.length;
    const groupWidth = innerW / groupCount;
    const barWidth = Math.min(18, groupWidth / 4.2);

    const series = [
      { key: "targetScore", color: "#a5b4fc", label: "Target Score" },
      { key: "pActivityNorm", color: "#818cf8", label: "pActivity / 12" },
      { key: "heuristicScore", color: "#4f46e5", label: "Final Score" },
    ];

    let bars = "";
    top.forEach((c, i) => {
      const gx = margin.left + i * groupWidth + groupWidth / 2;
      const values = { targetScore: c.targetScore, pActivityNorm: c.pActivity / 12, heuristicScore: c.heuristicScore };
      series.forEach((s, si) => {
        const v = Math.max(0, Math.min(1, values[s.key]));
        const barH = v * innerH;
        const x = gx - barWidth * 1.5 + si * (barWidth + 4);
        const y = margin.top + innerH - barH;
        bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${s.color}" rx="2"></rect>`;
      });
      const label = c.compoundId.replace("CHEMBL", "C");
      bars += `<text x="${gx}" y="${height - margin.bottom + 18}" font-size="10" fill="#64748b" text-anchor="middle">${label}</text>`;
    });

    let axis = `<line x1="${margin.left}" y1="${margin.top + innerH}" x2="${width - margin.right}" y2="${margin.top + innerH}" stroke="#e2e8f0" />`;
    axis += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerH}" stroke="#e2e8f0" />`;

    let legend = "";
    series.forEach((s, i) => {
      const lx = margin.left + i * 140;
      legend += `<rect x="${lx}" y="${height - 16}" width="10" height="10" fill="${s.color}" rx="2"></rect>`;
      legend += `<text x="${lx + 14}" y="${height - 7}" font-size="11" fill="#475569">${s.label}</text>`;
    });

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.innerHTML = axis + bars + legend;
  }

  // ---------------------------------------------------------------------
  // Candidate detail modal
  // ---------------------------------------------------------------------
  function openModal(c) {
    const weights = state.result.weights;
    $("modal-rank").textContent = `Rank #${c.rank}`;
    $("modal-compound").textContent = c.compoundId;
    $("modal-dl").innerHTML = `
      <dt>Target</dt><dd>${escapeHtml(c.targetSymbol)} — ${escapeHtml(c.targetName || "")}</dd>
      <dt>Target association score</dt><dd class="mono">${c.targetScore.toFixed(3)}</dd>
      <dt>Activity type</dt><dd>${escapeHtml(c.activityType)} (relation ${escapeHtml(c.standardRelation || "=")})</dd>
      <dt>Activity value</dt><dd class="mono">${c.valueNM} nM</dd>
      <dt>pActivity</dt><dd class="mono">${c.pActivity} ${c.pchemblProvided ? "(ChEMBL pChEMBL value)" : "(derived from value + unit)"}</dd>
      <dt>Heuristic score</dt><dd class="mono"><strong>${c.heuristicScore.toFixed(4)}</strong></dd>
      <dt>Assay</dt><dd>${escapeHtml(c.assayId || "—")} ${c.assayDescription ? "— " + escapeHtml(c.assayDescription) : ""}</dd>
      <dt>Document year</dt><dd>${escapeHtml(c.documentYear ? String(c.documentYear) : "—")}</dd>
      <dt>SMILES</dt><dd class="mono" style="font-size:11px">${escapeHtml(c.smiles || "—")}</dd>
      <dt>Source</dt><dd>Open Targets + ChEMBL</dd>
    `;
    $("explain-formula").textContent = `h = w1 × target_score + w2 × (pActivity / 12), with w1=${weights.w1}, w2=${weights.w2}`;

    const maxVal = c.targetContribution + c.bioactivityContribution || 1;
    const pct1 = Math.min(100, (c.targetContribution / maxVal) * 100);
    const pct2 = Math.min(100, (c.bioactivityContribution / maxVal) * 100);
    $("score-bars").innerHTML = `
      <div class="score-bar-row">
        <div class="top"><span>Target contribution (${weights.w1} × ${c.targetScore.toFixed(3)})</span><span class="mono">${c.targetContribution.toFixed(4)}</span></div>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct1}%"></div></div>
      </div>
      <div class="score-bar-row">
        <div class="top"><span>Bioactivity contribution (${weights.w2} × ${c.pActivity}/12)</span><span class="mono">${c.bioactivityContribution.toFixed(4)}</span></div>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct2}%"></div></div>
      </div>
      <div class="score-bar-final"><span>Final heuristic score</span><span class="mono">${c.heuristicScore.toFixed(4)}</span></div>
    `;

    $("modal-backdrop").style.display = "flex";
  }

  $("modal-close").addEventListener("click", () => ($("modal-backdrop").style.display = "none"));
  $("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") $("modal-backdrop").style.display = "none";
  });

  // ---------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }
})();
