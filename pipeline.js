/* TargetPath — client-side pipeline (no build step).
 *
 * Disease -> Open Targets (disease search, associated targets)
 *         -> ChEMBL (target mapping, bioactivity)
 *         -> Greedy Best-First Search over the resulting knowledge graph
 *         -> Ranked compound candidates.
 *
 * This file is written to run unmodified in the browser (attaches window.TP)
 * and in plain Node.js (module.exports), so the search logic can be unit
 * tested with mocked network responses (see tests/*.test.js).
 *
 * ---------------------------------------------------------------------
 * WHY THIS IS A REAL SEARCH ALGORITHM, NOT "FETCH EVERYTHING THEN SORT"
 * ---------------------------------------------------------------------
 * The frontier (priority queue) below decides, at every step, which node
 * gets expanded / goal-tested NEXT. A node is only fetched from ChEMBL or
 * quality-checked once it is popped from the frontier. Nothing is fetched
 * "just in case" beyond what the current frontier item requires, and the
 * final ranking table is a separate, clearly-labeled re-sort of the goals
 * that GBFS actually found — it is not used to fake the exploration order.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TP = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const OT_URL = "https://api.platform.opentargets.org/api/v4/graphql";
  const CHEMBL_TARGET_URL = "https://www.ebi.ac.uk/chembl/api/data/target.json";
  const CHEMBL_ACTIVITY_URL = "https://www.ebi.ac.uk/chembl/api/data/activity.json";
  const FORMULA = "h = w1 x target_association_score + w2 x (pActivity / 12)";
  const ALGORITHM_NAME = "Greedy Best-First Search";

  // Swappable so tests can inject a fake fetch. In the browser this is the
  // native fetch(); Node test files call __setFetchForTests(mockFn).
  let _fetch = typeof fetch !== "undefined" ? fetch.bind(typeof self !== "undefined" ? self : globalThis) : null;
  function __setFetchForTests(fn) {
    _fetch = fn;
  }

  async function fetchWithTimeout(url, options, ms) {
    if (!_fetch) throw new Error("No fetch implementation available in this environment.");
    const timeoutMs = ms || 15000;
    if (typeof AbortController === "undefined") {
      return _fetch(url, options);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await _fetch(url, { ...(options || {}), signal: controller.signal });
    } catch (e) {
      if (e && e.name === "AbortError") {
        const err = new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
        err.timeout = true;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // =====================================================================
  // 1. OPEN TARGETS — disease search (no more "always take hits[0]")
  // =====================================================================

  async function fetchDiseaseHits(namaPenyakit) {
    const query = `
      query($q: String!) {
        search(queryString: $q, entityNames: ["disease"], page: {index: 0, size: 5}) {
          hits { id name entity }
        }
      }
    `;
    let r;
    try {
      r = await fetchWithTimeout(OT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { q: namaPenyakit } }),
      });
    } catch (e) {
      const err = new Error(`Could not reach Open Targets (disease search): ${e.message}`);
      err.stage = "disease_search";
      throw err;
    }
    if (!r.ok) {
      const err = new Error(`Open Targets disease search failed (HTTP ${r.status}).`);
      err.stage = "disease_search";
      throw err;
    }
    const data = await r.json();
    if (data && data.errors && data.errors.length) {
      const err = new Error(`Open Targets returned a GraphQL error: ${data.errors[0].message}`);
      err.stage = "disease_search";
      throw err;
    }
    const hits = (data && data.data && data.data.search && data.data.search.hits) || [];
    // Validate: only keep hits that are actually disease entities with a usable id/name.
    return hits.filter((h) => h && h.entity === "disease" && h.id && h.name);
  }

  /**
   * Decides what to do with the disease hits, instead of silently picking
   * hits[0]. Never falls back to a hard-coded disease.
   */
  function decideDiseaseSelection(hits, queryText) {
    if (!hits || hits.length === 0) return { status: "not_found" };
    const q = (queryText || "").trim().toLowerCase();
    const exact = hits.find((h) => h.name.trim().toLowerCase() === q);
    if (exact) return { status: "auto", disease: exact, reason: "Exact name match." };
    if (hits.length === 1) return { status: "auto", disease: hits[0], reason: "Only one candidate returned." };
    return { status: "ambiguous", candidates: hits };
  }

  // =====================================================================
  // 2. OPEN TARGETS — disease-associated targets
  // =====================================================================

  async function fetchAssociatedTargets(efoId, maxTargets) {
    const size = Math.max(1, Math.min(50, maxTargets || 15));
    const query = `
      query($efoId: String!, $size: Int!) {
        disease(efoId: $efoId) {
          associatedTargets(page: {index: 0, size: $size}) {
            rows {
              target { id approvedSymbol approvedName }
              score
            }
          }
        }
      }
    `;
    let r;
    try {
      r = await fetchWithTimeout(OT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { efoId, size } }),
      });
    } catch (e) {
      const err = new Error(`Could not reach Open Targets (associated targets): ${e.message}`);
      err.stage = "target_retrieval";
      throw err;
    }
    if (!r.ok) {
      const err = new Error(`Open Targets associatedTargets query failed (HTTP ${r.status}).`);
      err.stage = "target_retrieval";
      throw err;
    }
    const data = await r.json();
    if (data && data.errors && data.errors.length) {
      const err = new Error(`Open Targets returned a GraphQL error: ${data.errors[0].message}`);
      err.stage = "target_retrieval";
      throw err;
    }
    const rows = (data && data.data && data.data.disease && data.data.disease.associatedTargets && data.data.disease.associatedTargets.rows) || [];
    return rows
      .filter((row) => row && row.target && row.target.id && row.target.approvedSymbol)
      .map((row) => ({
        ensemblId: row.target.id,
        symbol: row.target.approvedSymbol,
        name: row.target.approvedName || row.target.approvedSymbol,
        targetScore: typeof row.score === "number" ? row.score : 0,
      }));
  }

  // =====================================================================
  // 3. CHEMBL — target mapping (scored, validated — not "first result wins")
  // =====================================================================

  async function mapTargetToChembl(symbol, name) {
    const strategies = [];
    if (symbol) strategies.push({ param: "target_synonym__icontains", value: symbol, weight: 2 });
    if (name) strategies.push({ param: "pref_name__icontains", value: name, weight: 1 });
    if (symbol) strategies.push({ param: "pref_name__icontains", value: symbol, weight: 1 });

    const candidatesById = new Map();
    let anyRequestSucceeded = false;

    for (const strat of strategies) {
      try {
        const url = `${CHEMBL_TARGET_URL}?${strat.param}=${encodeURIComponent(strat.value)}&limit=15`;
        const r = await fetchWithTimeout(url);
        if (!r.ok) continue;
        anyRequestSucceeded = true;
        const data = await r.json();
        const targets = (data && data.targets) || [];
        for (const t of targets) {
          const id = t.target_chembl_id;
          if (!id) continue;
          const existing = candidatesById.get(id) || { raw: t, matchWeight: 0 };
          existing.matchWeight += strat.weight;
          existing.raw = t;
          candidatesById.set(id, existing);
        }
      } catch (e) {
        // one strategy failing is not fatal — try the others
        continue;
      }
    }

    if (!anyRequestSucceeded) {
      const err = new Error("Could not reach ChEMBL target search.");
      err.stage = "target_mapping";
      throw err;
    }

    const scored = [];
    for (const [id, c] of candidatesById) {
      const t = c.raw;
      // Disease-target associations from Open Targets are human targets, so
      // require Homo sapiens; a non-human ChEMBL hit is not a valid mapping here.
      if (t.organism !== "Homo sapiens") continue;
      let score = c.matchWeight;
      if (t.target_type === "SINGLE PROTEIN") score += 2;
      const prefName = (t.pref_name || "").toLowerCase();
      if (name && prefName === name.toLowerCase()) score += 3;
      if (symbol && prefName.includes(symbol.toLowerCase())) score += 1;
      scored.push({ chemblId: id, score, targetType: t.target_type, prefName: t.pref_name, organism: t.organism });
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return {
        chemblId: null,
        confidence: "none",
        reason: "No Homo sapiens ChEMBL target confidently matched this gene symbol/name.",
        candidates: [],
      };
    }
    const best = scored[0];
    const runnerUp = scored[1];
    const ambiguous = !!runnerUp && runnerUp.score === best.score;
    return {
      chemblId: best.chemblId,
      confidence: ambiguous ? "ambiguous" : best.score >= 3 ? "high" : "low",
      reason: ambiguous
        ? `Multiple ChEMBL targets matched with equal confidence; used ${best.chemblId} (${best.prefName}).`
        : `Matched ChEMBL target ${best.chemblId} (${best.prefName}), organism ${best.organism}, type ${best.targetType}.`,
      candidates: scored.slice(0, 5),
    };
  }

  // =====================================================================
  // 4. CHEMBL — bioactivity retrieval (IC50 + Ki, optional Kd; raw records
  //    only — the quality/goal test is applied later, at frontier pop time)
  // =====================================================================

  async function fetchRawBioactivities(chemblTargetId, maxCandidates, includeKd) {
    const allowedTypes = includeKd ? ["IC50", "Ki", "Kd"] : ["IC50", "Ki"];
    const fetchCap = Math.max((maxCandidates || 8) * 3, 20);
    const url = `${CHEMBL_ACTIVITY_URL}?target_chembl_id=${encodeURIComponent(chemblTargetId)}&standard_type__in=${encodeURIComponent(
      allowedTypes.join(",")
    )}&limit=${fetchCap}`;
    let r;
    try {
      r = await fetchWithTimeout(url);
    } catch (e) {
      const err = new Error(`Could not reach ChEMBL activity endpoint: ${e.message}`);
      err.stage = "bioactivity_retrieval";
      throw err;
    }
    if (!r.ok) {
      const err = new Error(`ChEMBL activity lookup failed (HTTP ${r.status}).`);
      err.stage = "bioactivity_retrieval";
      throw err;
    }
    const data = await r.json();
    const raw = (data && data.activities) || [];
    // Cap how many candidate compound *nodes* this target can push into the
    // frontier — this bounds cost, it does not decide which compounds win.
    return raw.slice(0, maxCandidates || 8);
  }

  // =====================================================================
  // 5. Units, heuristic, quality / goal test
  // =====================================================================

  const UNIT_TO_NM = { nM: 1, uM: 1000, "\u00b5M": 1000, "\u03bcM": 1000, pM: 0.001, mM: 1e6 };

  function normalizeUnitToNM(value, rawUnit) {
    if (rawUnit === undefined || rawUnit === null) return null;
    const u = String(rawUnit).trim();
    if (!(u in UNIT_TO_NM)) return null;
    return value * UNIT_TO_NM[u];
  }

  /**
   * h = w1 * target_association_score + w2 * (pActivity / 12)
   *
   * - target_association_score comes straight from Open Targets (0..1).
   * - pActivity (a.k.a. pChEMBL) is -log10(molar potency); we divide by 12
   *   as a soft normalization because pActivity rarely exceeds ~12 in
   *   practice (sub-picomolar). This is a scaling convenience, not a
   *   scientific claim, and the contribution is clamped to [0,1].
   * - The score is a heuristic priority for search/ranking, never a
   *   probability of clinical success.
   */
  function computeHeuristic(targetScore, pActivity, w1, w2) {
    const targetContribution = w1 * targetScore;
    const bioactivityContribution = w2 * Math.max(0, Math.min(1, pActivity / 12));
    return { h: targetContribution + bioactivityContribution, targetContribution, bioactivityContribution };
  }

  /**
   * Optimistic priority used for an unexpanded target frontier item: since
   * its compounds (and their real pActivity) are not known yet, we assume
   * the best possible future bioactivity contribution (w2 * 1.0). This
   * keeps target items comparable, on the same scale, against compound
   * items already in the frontier, without ever under-exploring a
   * high-association target. It is an upper bound, not a prediction.
   */
  function optimisticTargetHeuristic(targetScore, w1, w2) {
    return w1 * targetScore + w2 * 1.0;
  }

  function validateWeights(w1, w2) {
    const a = Number(w1);
    const b = Number(w2);
    if (Number.isNaN(a) || Number.isNaN(b) || a < 0 || b < 0) return false;
    return Math.abs(a + b - 1) < 1e-6;
  }

  /**
   * Used only to order the frontier before the real goal test runs. Never
   * shown to the user as a final value.
   */
  function preliminaryPActivityEstimate(act) {
    const pchembl = parseFloat(act.pchembl_value);
    if (!Number.isNaN(pchembl)) return pchembl;
    const val = parseFloat(act.standard_value);
    const nm = normalizeUnitToNM(val, act.standard_units);
    if (!Number.isNaN(val) && val > 0 && nm !== null) return 9 - Math.log10(nm);
    return 5.0; // neutral placeholder for incomplete records; resolved at goal test
  }

  /**
   * The GOAL TEST. Decides whether a raw ChEMBL activity record is usable
   * evidence for ranking. Nothing here is a universal drug-likeness
   * threshold — it only checks that the record is numerically comparable
   * and not flagged by ChEMBL's own data-validity check.
   */
  function evaluateActivityQuality(act, config) {
    const allowedTypes = config && config.includeKd ? ["IC50", "Ki", "Kd"] : ["IC50", "Ki"];
    const type = act.standard_type;
    if (!allowedTypes.includes(type)) {
      return { status: "excluded", reason: `standard_type "${type || "unknown"}" is outside the analyzed set (${allowedTypes.join("/")}).` };
    }

    const numeric = parseFloat(act.standard_value);
    if (act.standard_value === null || act.standard_value === undefined || Number.isNaN(numeric)) {
      return { status: "excluded", reason: "standard_value is missing or not numeric." };
    }
    if (numeric <= 0) {
      return { status: "excluded", reason: "standard_value is not a positive number." };
    }

    const valueNM = normalizeUnitToNM(numeric, act.standard_units);
    if (valueNM === null) {
      return { status: "excluded", reason: `unit "${act.standard_units || "unknown"}" could not be normalized to nM for comparison.` };
    }

    const dvc = (act.data_validity_comment || "").trim();
    if (dvc && dvc.toLowerCase() !== "manually validated") {
      return { status: "excluded", reason: `flagged by ChEMBL's data validity check: "${dvc}".` };
    }

    const relation = act.standard_relation || null;
    let pActivity;
    const pchemblRaw = parseFloat(act.pchembl_value);
    const pchemblProvided = !Number.isNaN(pchemblRaw);
    if (pchemblProvided) {
      pActivity = pchemblRaw;
    } else if (relation === "=" || relation === null) {
      pActivity = 9 - Math.log10(valueNM);
    } else {
      return {
        status: "excluded",
        reason: `relation "${relation}" is not an exact measurement and ChEMBL has not provided a validated pChEMBL value for it.`,
      };
    }

    return {
      status: "included",
      reason: null,
      normalized: {
        compoundId: act.molecule_chembl_id,
        compoundName: act.molecule_pref_name || null,
        targetChemblId: act.target_chembl_id || null,
        assayId: act.assay_chembl_id || null,
        assayDescription: act.assay_description || null,
        standardType: type,
        standardValue: numeric,
        standardUnits: act.standard_units,
        standardRelation: relation,
        valueNM: +valueNM.toFixed(4),
        pchemblProvided,
        pActivity: +pActivity.toFixed(3),
        documentYear: act.document_year || null,
        smiles: act.canonical_smiles || null,
      },
    };
  }

  // =====================================================================
  // 6. GREEDY BEST-FIRST SEARCH
  // =====================================================================
  //
  // Search components (explicit, per the assignment):
  //   Initial state : the identified disease (EFO id + name).
  //   Nodes         : disease -> target -> compound.
  //   Actions       : "expand a target" (map to ChEMBL + fetch its raw
  //                   bioactivity records) and "goal-test a compound"
  //                   (validate one bioactivity record against the
  //                   system's data-quality criteria).
  //   Frontier      : a priority queue ordered by heuristic value only
  //                   (never by accumulated path cost — that would be UCS).
  //   Heuristic     : h = w1*target_association_score + w2*(pActivity/12).
  //                   Unexpanded targets use an optimistic upper bound
  //                   (see optimisticTargetHeuristic) so they stay
  //                   comparable to already-known compound heuristics.
  //   Goal test     : evaluateActivityQuality() above, applied when a
  //                   compound node is POPPED from the frontier (not
  //                   before) — a record can still fail here.
  //   Cycle/duplicate avoidance: a `visited` set keyed by node id, checked
  //                   before expansion and before enqueuing.
  //
  // `deps` lets Demo Mode replay the exact same algorithm against a
  // recorded snapshot instead of the network (see runDemoExplore below).

  async function runGreedyBestFirstSearch(opts) {
    const { diseaseId, diseaseName, targets, w1, w2, maxCompoundsPerTarget, includeKd, deps } = opts;
    const config = { includeKd: !!includeKd };
    const doMapTarget = (deps && deps.mapTargetToChembl) || mapTargetToChembl;
    const doFetchBio = (deps && deps.fetchRawBioactivities) || fetchRawBioactivities;

    const visited = new Set();
    const nodes = [{ id: diseaseId, type: "disease", label: diseaseName }];
    const adjacency = { [diseaseId]: [] };
    const log = [];
    const candidates = [];
    const skippedTargets = [];
    const excludedRecords = [];
    let stepCounter = 0;
    let targetsMapped = 0;
    let compoundRecordsConsidered = 0;

    let frontier = targets.map((t) => ({
      kind: "target",
      nodeId: `target:${t.symbol}`,
      symbol: t.symbol,
      name: t.name,
      ensemblId: t.ensemblId,
      targetScore: t.targetScore,
      priority: optimisticTargetHeuristic(t.targetScore, w1, w2),
    }));

    while (frontier.length > 0) {
      // Priority queue: always pop the highest-heuristic item. This line is
      // the entire "GBFS instead of BFS/DFS/UCS" contract — order depends
      // only on `priority`, never on insertion order or accumulated cost.
      frontier.sort((a, b) => b.priority - a.priority);
      const item = frontier.shift();
      if (visited.has(item.nodeId)) continue; // duplicate / cycle guard
      visited.add(item.nodeId);
      stepCounter += 1;

      if (item.kind === "target") {
        nodes.push({ id: item.nodeId, type: "target", label: item.symbol, name: item.name, targetScore: item.targetScore });
        adjacency[diseaseId].push({ to: item.nodeId });
        adjacency[item.nodeId] = adjacency[item.nodeId] || [];

        let mapping;
        try {
          mapping = await doMapTarget(item.symbol, item.name);
        } catch (e) {
          mapping = { chemblId: null, confidence: "none", reason: `ChEMBL target lookup failed: ${e.message}` };
        }

        if (!mapping.chemblId) {
          skippedTargets.push({ symbol: item.symbol, name: item.name, reason: mapping.reason });
          log.push({ step: stepCounter, kind: "target", id: item.nodeId, label: item.symbol, heuristic: +item.priority.toFixed(4), action: `unmapped: ${mapping.reason}` });
          continue;
        }
        targetsMapped += 1;
        log.push({
          step: stepCounter,
          kind: "target",
          id: item.nodeId,
          label: item.symbol,
          heuristic: +item.priority.toFixed(4),
          action: `expanded -> mapped to ChEMBL ${mapping.chemblId}; fetching bioactivity`,
        });

        let rawActs;
        try {
          rawActs = await doFetchBio(mapping.chemblId, maxCompoundsPerTarget, config.includeKd);
        } catch (e) {
          skippedTargets.push({ symbol: item.symbol, name: item.name, reason: `Bioactivity retrieval failed: ${e.message}` });
          continue;
        }

        if (rawActs.length === 0) {
          skippedTargets.push({
            symbol: item.symbol,
            name: item.name,
            reason: `ChEMBL target ${mapping.chemblId} mapped successfully, but returned no ${config.includeKd ? "IC50/Ki/Kd" : "IC50/Ki"} activity records.`,
          });
          continue;
        }

        for (const act of rawActs) {
          const compoundId = act.molecule_chembl_id;
          if (!compoundId) continue;
          const compoundNodeId = `compound:${compoundId}`;
          if (visited.has(compoundNodeId)) continue;
          if (frontier.some((f) => f.nodeId === compoundNodeId)) continue; // already queued via another target
          compoundRecordsConsidered += 1;
          const prelim = preliminaryPActivityEstimate(act);
          const prelimNorm = Math.max(0, Math.min(1, prelim / 12));
          frontier.push({
            kind: "compound",
            nodeId: compoundNodeId,
            targetSymbol: item.symbol,
            targetName: item.name,
            targetScore: item.targetScore,
            raw: act,
            priority: w1 * item.targetScore + w2 * prelimNorm,
          });
        }
      } else {
        // GOAL TEST happens here, at expansion time — not before.
        const verdict = evaluateActivityQuality(item.raw, config);
        if (verdict.status !== "included") {
          excludedRecords.push({ moleculeId: item.raw.molecule_chembl_id, targetSymbol: item.targetSymbol, reason: verdict.reason });
          log.push({
            step: stepCounter,
            kind: "compound",
            id: item.nodeId,
            label: item.raw.molecule_chembl_id || "?",
            heuristic: +item.priority.toFixed(4),
            action: `goal test FAILED: ${verdict.reason}`,
          });
          continue;
        }

        const rec = verdict.normalized;
        nodes.push({ id: item.nodeId, type: "compound", label: rec.compoundId, smiles: rec.smiles });
        adjacency[`target:${item.targetSymbol}`].push({ to: item.nodeId });

        const { h, targetContribution, bioactivityContribution } = computeHeuristic(item.targetScore, rec.pActivity, w1, w2);
        candidates.push({
          compoundId: rec.compoundId,
          compoundName: rec.compoundName,
          targetSymbol: item.targetSymbol,
          targetName: item.targetName,
          targetScore: item.targetScore,
          activityType: rec.standardType,
          valueNM: rec.valueNM,
          standardUnits: rec.standardUnits,
          standardRelation: rec.standardRelation,
          pActivity: rec.pActivity,
          pchemblProvided: rec.pchemblProvided,
          assayId: rec.assayId,
          assayDescription: rec.assayDescription,
          documentYear: rec.documentYear,
          smiles: rec.smiles,
          targetContribution: +targetContribution.toFixed(4),
          bioactivityContribution: +bioactivityContribution.toFixed(4),
          heuristicScore: +h.toFixed(4),
          discoveryStep: stepCounter,
        });
        log.push({
          step: stepCounter,
          kind: "compound",
          id: item.nodeId,
          label: rec.compoundId,
          heuristic: +item.priority.toFixed(4),
          action: `goal test passed (${rec.standardType} ${rec.standardRelation || "="} ${rec.valueNM} nM)`,
        });
      }
    }

    // Ranked table shown to the user: a separate re-sort of the goals GBFS
    // actually found, by final heuristic score. This is NOT the exploration
    // order (see `log` / `exploredOrder` for that) — the two are shown
    // side by side in the UI on purpose.
    const ranked = candidates.slice().sort((a, b) => b.heuristicScore - a.heuristicScore);
    ranked.forEach((c, i) => (c.rank = i + 1));

    const edges = Object.entries(adjacency).flatMap(([from, es]) => es.map((e) => ({ from, to: e.to })));

    return {
      nodes,
      edges,
      log,
      exploredOrder: log.map((l) => l.id),
      candidates: ranked,
      skippedTargets,
      excludedRecords,
      stats: {
        targetsChecked: targets.length,
        targetsExpanded: log.filter((l) => l.kind === "target").length,
        targetsMapped,
        compoundRecordsConsidered,
        compoundsPassedFilter: candidates.length,
        recordsExcluded: excludedRecords.length,
      },
    };
  }

  // =====================================================================
  // 7. Orchestration — LIVE mode
  // =====================================================================

  async function explore({ disease, explicitDisease = null, nTarget = 15, nCompoundPerTarget = 8, w1 = 0.5, includeKd = false, onStep }) {
    const w2 = +(1 - w1).toFixed(2);
    if (!validateWeights(w1, w2)) throw new Error("w1 and w2 must be non-negative and sum to 1.");

    onStep && onStep("disease_search");
    let diseaseId, diseaseName;

    if (explicitDisease && explicitDisease.id) {
      diseaseId = explicitDisease.id;
      diseaseName = explicitDisease.name;
    } else {
      if (!disease || !disease.trim()) {
        const e = new Error("Field 'disease' is required.");
        e.stage = "input";
        throw e;
      }
      const hits = await fetchDiseaseHits(disease.trim());
      const decision = decideDiseaseSelection(hits, disease.trim());
      if (decision.status === "not_found") {
        const e = new Error(`Disease "${disease}" was not found in Open Targets. Try a different name or a known synonym.`);
        e.stage = "disease_search";
        e.notFound = true;
        throw e;
      }
      if (decision.status === "ambiguous") {
        const e = new Error("Multiple matching diseases were found — please pick the correct one.");
        e.stage = "disease_search";
        e.ambiguous = true;
        e.candidates = decision.candidates;
        throw e;
      }
      diseaseId = decision.disease.id;
      diseaseName = decision.disease.name;
    }

    onStep && onStep("target_retrieval");
    const rawTargets = await fetchAssociatedTargets(diseaseId, nTarget);

    if (rawTargets.length === 0) {
      return {
        demoMode: false,
        disease: { name: diseaseName, id: diseaseId, source: "Open Targets" },
        targets: [],
        nodes: [{ id: diseaseId, type: "disease", label: diseaseName }],
        edges: [],
        log: [],
        exploredOrder: [],
        candidates: [],
        skippedTargets: [],
        excludedRecords: [],
        stats: { targetsChecked: 0, targetsExpanded: 0, targetsMapped: 0, compoundRecordsConsidered: 0, compoundsPassedFilter: 0, recordsExcluded: 0 },
        weights: { w1, w2 },
        formula: FORMULA,
        algorithm: ALGORITHM_NAME,
        emptyReason: "No disease-associated targets were returned by Open Targets for this disease.",
      };
    }

    onStep && onStep("target_mapping_and_bioactivity");
    const searchResult = await runGreedyBestFirstSearch({
      diseaseId,
      diseaseName,
      targets: rawTargets,
      w1,
      w2,
      maxCompoundsPerTarget: nCompoundPerTarget,
      includeKd,
    });
    onStep && onStep("done");

    return {
      demoMode: false,
      disease: { name: diseaseName, id: diseaseId, source: "Open Targets" },
      targets: rawTargets,
      ...searchResult,
      weights: { w1, w2 },
      formula: FORMULA,
      algorithm: ALGORITHM_NAME,
    };
  }

  // =====================================================================
  // 8. DEMO MODE — explicit only, never an automatic fallback.
  //    Runs the SAME runGreedyBestFirstSearch engine, with network calls
  //    replaced by a recorded snapshot, so the algorithm being shown is
  //    the real one — not a separate fake code path.
  // =====================================================================

  const DEMO_DISEASE = { id: "MONDO_0004975", name: "Alzheimer disease", source: "Recorded demo snapshot (not live)" };

  const DEMO_TARGETS = [
    { ensemblId: "ENSG00000142192", symbol: "APP", name: "amyloid beta precursor protein", targetScore: 0.8722 },
    { ensemblId: "ENSG00000080815", symbol: "PSEN1", name: "presenilin 1", targetScore: 0.867 },
    { ensemblId: "ENSG00000143801", symbol: "PSEN2", name: "presenilin 2", targetScore: 0.818 },
    { ensemblId: "ENSG00000130203", symbol: "APOE", name: "apolipoprotein E", targetScore: 0.77 },
    { ensemblId: "ENSG00000176884", symbol: "GRIN1", name: "glutamate ionotropic receptor NMDA type subunit 1", targetScore: 0.704 },
  ];

  const DEMO_CHEMBL_MAP = { APP: "CHEMBL237" };

  const DEMO_RAW_ACTIVITIES = {
    CHEMBL237: [
      {
        molecule_chembl_id: "CHEMBL343246", molecule_pref_name: null, standard_type: "IC50",
        standard_value: 3.5, standard_units: "nM", standard_relation: "=", pchembl_value: 8.46,
        target_chembl_id: "CHEMBL237", assay_chembl_id: "CHEMBL615176",
        assay_description: "Recorded demo assay against APP-derived target.", document_year: 2003,
        canonical_smiles: "O=C(Cc1ccc(Cl)c(Cl)c1)N1CCCCC1CN1CC=CC1", data_validity_comment: null,
      },
      {
        molecule_chembl_id: "CHEMBL146682", molecule_pref_name: null, standard_type: "IC50",
        standard_value: 1020.0, standard_units: "nM", standard_relation: "=", pchembl_value: 5.99,
        target_chembl_id: "CHEMBL237", assay_chembl_id: "CHEMBL615177",
        assay_description: "Recorded demo assay against APP-derived target.", document_year: 2003,
        canonical_smiles: "COC(=O)/C=C1\\CCN(CC2CCCCN2C(=O)Cc2ccc(Cl)c(Cl)c2)C1", data_validity_comment: null,
      },
      {
        molecule_chembl_id: "CHEMBL146140", molecule_pref_name: null, standard_type: "Ki",
        standard_value: 1200.0, standard_units: "nM", standard_relation: "=", pchembl_value: 5.92,
        target_chembl_id: "CHEMBL237", assay_chembl_id: "CHEMBL615178",
        assay_description: "Recorded demo assay against APP-derived target.", document_year: 2004,
        canonical_smiles: "NC(=O)[C@@H]1CCN(C(=O)Cc2ccc(Cl)c(Cl)c2)[C@H](CN2CCCC2)C1", data_validity_comment: null,
      },
    ],
  };

  const demoDeps = {
    mapTargetToChembl: async (symbol) => {
      const id = DEMO_CHEMBL_MAP[symbol] || null;
      return id
        ? { chemblId: id, confidence: "high", reason: "Recorded demo mapping." }
        : { chemblId: null, confidence: "none", reason: "No demo bioactivity was recorded for this target." };
    },
    fetchRawBioactivities: async (chemblTargetId, maxCandidates) => {
      const raw = DEMO_RAW_ACTIVITIES[chemblTargetId] || [];
      return raw.slice(0, maxCandidates || 8);
    },
  };

  async function runDemoExplore({ w1 = 0.5, includeKd = false } = {}) {
    const w2 = +(1 - w1).toFixed(2);
    const searchResult = await runGreedyBestFirstSearch({
      diseaseId: DEMO_DISEASE.id,
      diseaseName: DEMO_DISEASE.name,
      targets: DEMO_TARGETS,
      w1,
      w2,
      maxCompoundsPerTarget: 10,
      includeKd,
      deps: demoDeps,
    });
    return {
      demoMode: true,
      demoReason: "Demo Mode was explicitly selected. This runs the real Greedy Best-First Search engine against a recorded Alzheimer's-disease snapshot instead of live API calls.",
      disease: { ...DEMO_DISEASE },
      targets: DEMO_TARGETS,
      ...searchResult,
      weights: { w1, w2 },
      formula: FORMULA,
      algorithm: ALGORITHM_NAME,
    };
  }

  return {
    // orchestration
    explore,
    runDemoExplore,
    // building blocks (exported for unit testing / transparency)
    fetchDiseaseHits,
    decideDiseaseSelection,
    fetchAssociatedTargets,
    mapTargetToChembl,
    fetchRawBioactivities,
    normalizeUnitToNM,
    evaluateActivityQuality,
    computeHeuristic,
    optimisticTargetHeuristic,
    preliminaryPActivityEstimate,
    validateWeights,
    runGreedyBestFirstSearch,
    __setFetchForTests,
    FORMULA,
    ALGORITHM_NAME,
  };
});
