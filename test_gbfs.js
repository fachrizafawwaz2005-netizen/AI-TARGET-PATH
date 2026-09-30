/* Unit tests for TargetPath's pipeline.js.
 * Run with: node tests/test_gbfs.js
 * No dependencies beyond Node's built-in assert module.
 * These tests use MOCKED fetch responses (fixtures shaped like the real
 * Open Targets / ChEMBL APIs) — they do not hit the network. Anywhere the
 * real API differs from these fixtures is a risk noted in the README.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const TP = require(path.join(__dirname, "pipeline.js"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  - ${name}`);
    })
    .catch((e) => {
      failed += 1;
      console.log(`FAIL  - ${name}`);
      console.log(`        ${e.message}`);
    });
}

function jsonResponse(obj, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: async () => obj });
}

async function main() {
  console.log("TargetPath GBFS unit tests\n");

  // -------------------------------------------------------------------
  await test("normalizeUnitToNM converts uM and pM correctly, rejects unknown units", () => {
    assert.strictEqual(TP.normalizeUnitToNM(1, "nM"), 1);
    assert.strictEqual(TP.normalizeUnitToNM(1, "uM"), 1000);
    assert.strictEqual(TP.normalizeUnitToNM(1, "pM"), 0.001);
    assert.strictEqual(TP.normalizeUnitToNM(1, "mg/mL"), null);
    assert.strictEqual(TP.normalizeUnitToNM(1, undefined), null);
  });

  // -------------------------------------------------------------------
  await test("computeHeuristic combines target score and normalized pActivity with w1/w2", () => {
    const { h, targetContribution, bioactivityContribution } = TP.computeHeuristic(0.8, 6, 0.5, 0.5);
    assert.strictEqual(targetContribution, 0.4);
    assert.ok(Math.abs(bioactivityContribution - 0.5 * (6 / 12)) < 1e-9);
    assert.ok(Math.abs(h - (targetContribution + bioactivityContribution)) < 1e-9);
  });

  await test("computeHeuristic clamps pActivity contribution to [0,1] for extreme values", () => {
    const { bioactivityContribution } = TP.computeHeuristic(0.5, 999, 0.5, 0.5);
    assert.strictEqual(bioactivityContribution, 0.5); // clamped to w2 * 1.0
  });

  await test("optimisticTargetHeuristic is an upper bound over computeHeuristic for any pActivity", () => {
    const optimistic = TP.optimisticTargetHeuristic(0.6, 0.4, 0.6);
    for (const p of [0, 3, 6, 9, 12]) {
      const { h } = TP.computeHeuristic(0.6, p, 0.4, 0.6);
      assert.ok(optimistic >= h - 1e-9, `optimistic (${optimistic}) should be >= h (${h}) at pActivity=${p}`);
    }
  });

  // -------------------------------------------------------------------
  await test("evaluateActivityQuality accepts a clean IC50 record and computes pActivity from pchembl_value", () => {
    const verdict = TP.evaluateActivityQuality(
      { standard_type: "IC50", standard_value: 3.5, standard_units: "nM", standard_relation: "=", pchembl_value: 8.46, molecule_chembl_id: "CHEMBL1", data_validity_comment: null },
      { includeKd: false }
    );
    assert.strictEqual(verdict.status, "included");
    assert.strictEqual(verdict.normalized.pActivity, 8.46);
    assert.strictEqual(verdict.normalized.pchemblProvided, true);
  });

  await test("evaluateActivityQuality rejects standard_type outside the allowed set", () => {
    const verdict = TP.evaluateActivityQuality({ standard_type: "EC50", standard_value: 10, standard_units: "nM" }, { includeKd: false });
    assert.strictEqual(verdict.status, "excluded");
    assert.ok(/standard_type/.test(verdict.reason));
  });

  await test("evaluateActivityQuality includes Kd only when includeKd=true", () => {
    const rec = { standard_type: "Kd", standard_value: 10, standard_units: "nM", standard_relation: "=", pchembl_value: 8, molecule_chembl_id: "CHEMBL2" };
    assert.strictEqual(TP.evaluateActivityQuality(rec, { includeKd: false }).status, "excluded");
    assert.strictEqual(TP.evaluateActivityQuality(rec, { includeKd: true }).status, "included");
  });

  await test("evaluateActivityQuality rejects non-exact relation without a validated pChEMBL value", () => {
    const verdict = TP.evaluateActivityQuality(
      { standard_type: "IC50", standard_value: 10000, standard_units: "nM", standard_relation: ">", pchembl_value: null, molecule_chembl_id: "CHEMBL3" },
      { includeKd: false }
    );
    assert.strictEqual(verdict.status, "excluded");
    assert.ok(/relation/.test(verdict.reason));
  });

  await test("evaluateActivityQuality rejects records flagged by ChEMBL's data validity check", () => {
    const verdict = TP.evaluateActivityQuality(
      { standard_type: "IC50", standard_value: 10, standard_units: "nM", standard_relation: "=", pchembl_value: 8, molecule_chembl_id: "CHEMBL4", data_validity_comment: "Outside typical range" },
      { includeKd: false }
    );
    assert.strictEqual(verdict.status, "excluded");
    assert.ok(/data validity/.test(verdict.reason));
  });

  await test("evaluateActivityQuality computes pActivity from value+unit when pchembl_value is absent", () => {
    const verdict = TP.evaluateActivityQuality(
      { standard_type: "Ki", standard_value: 1, standard_units: "nM", standard_relation: "=", pchembl_value: null, molecule_chembl_id: "CHEMBL5" },
      { includeKd: false }
    );
    assert.strictEqual(verdict.status, "included");
    assert.strictEqual(verdict.normalized.pActivity, 9); // 9 - log10(1) = 9
    assert.strictEqual(verdict.normalized.pchemblProvided, false);
  });

  // -------------------------------------------------------------------
  await test("decideDiseaseSelection auto-picks an exact name match among multiple hits", () => {
    const hits = [
      { id: "EFO_1", name: "Type 1 diabetes mellitus", entity: "disease" },
      { id: "EFO_2", name: "Type 2 diabetes mellitus", entity: "disease" },
    ];
    const d = TP.decideDiseaseSelection(hits, "Type 2 diabetes mellitus");
    assert.strictEqual(d.status, "auto");
    assert.strictEqual(d.disease.id, "EFO_2");
  });

  await test("decideDiseaseSelection reports ambiguous instead of silently picking hits[0]", () => {
    const hits = [
      { id: "EFO_1", name: "Some cancer", entity: "disease" },
      { id: "EFO_2", name: "Some other cancer", entity: "disease" },
    ];
    const d = TP.decideDiseaseSelection(hits, "cancer");
    assert.strictEqual(d.status, "ambiguous");
    assert.strictEqual(d.candidates.length, 2);
  });

  await test("decideDiseaseSelection reports not_found on empty hits (never falls back to Alzheimer)", () => {
    const d = TP.decideDiseaseSelection([], "a made up disease name");
    assert.strictEqual(d.status, "not_found");
  });

  // -------------------------------------------------------------------
  await test("mapTargetToChembl requires Homo sapiens + SINGLE PROTEIN and does not just take the first hit", async () => {
    TP.__setFetchForTests(async (url) => {
      if (String(url).includes("target_synonym__icontains")) {
        return jsonResponse({
          targets: [
            { target_chembl_id: "CHEMBL_MOUSE", organism: "Mus musculus", target_type: "SINGLE PROTEIN", pref_name: "Amyloid-beta precursor protein" },
            { target_chembl_id: "CHEMBL237", organism: "Homo sapiens", target_type: "SINGLE PROTEIN", pref_name: "Amyloid-beta A4 protein" },
          ],
        });
      }
      return jsonResponse({ targets: [] });
    });
    const mapping = await TP.mapTargetToChembl("APP", "amyloid beta precursor protein");
    assert.strictEqual(mapping.chemblId, "CHEMBL237");
    assert.notStrictEqual(mapping.chemblId, "CHEMBL_MOUSE");
  });

  await test("mapTargetToChembl returns chemblId=null (not a guess) when nothing human matches", async () => {
    TP.__setFetchForTests(async () => jsonResponse({ targets: [{ target_chembl_id: "CHEMBL_X", organism: "Rattus norvegicus", target_type: "SINGLE PROTEIN", pref_name: "Something" }] }));
    const mapping = await TP.mapTargetToChembl("ZZZ", "nonexistent target");
    assert.strictEqual(mapping.chemblId, null);
  });

  // -------------------------------------------------------------------
  await test("runGreedyBestFirstSearch explores in heuristic order, not insertion order, and dedupes a compound found via two targets", async () => {
    const targets = [
      { symbol: "LOW", name: "low-score target", ensemblId: "ENSG_LOW", targetScore: 0.2 },
      { symbol: "HIGH", name: "high-score target", ensemblId: "ENSG_HIGH", targetScore: 0.9 },
    ];
    const deps = {
      mapTargetToChembl: async (symbol) => ({ chemblId: `CHEMBL_${symbol}`, confidence: "high", reason: "test" }),
      fetchRawBioactivities: async (chemblTargetId) => {
        if (chemblTargetId === "CHEMBL_LOW") {
          return [{ molecule_chembl_id: "CHEMBL_SHARED", standard_type: "IC50", standard_value: 5, standard_units: "nM", standard_relation: "=", pchembl_value: 8.3, data_validity_comment: null }];
        }
        if (chemblTargetId === "CHEMBL_HIGH") {
          return [{ molecule_chembl_id: "CHEMBL_SHARED", standard_type: "IC50", standard_value: 5, standard_units: "nM", standard_relation: "=", pchembl_value: 8.3, data_validity_comment: null }];
        }
        return [];
      },
    };
    const result = await TP.runGreedyBestFirstSearch({
      diseaseId: "EFO_TEST", diseaseName: "Test disease", targets, w1: 0.5, w2: 0.5, maxCompoundsPerTarget: 5, includeKd: false, deps,
    });
    // HIGH must be expanded before LOW because it has a higher heuristic.
    const targetSteps = result.log.filter((l) => l.kind === "target");
    assert.strictEqual(targetSteps[0].label, "HIGH");
    assert.strictEqual(targetSteps[1].label, "LOW");
    // The shared compound must appear only once in the final candidate list.
    assert.strictEqual(result.candidates.filter((c) => c.compoundId === "CHEMBL_SHARED").length, 1);
  });

  await test("runGreedyBestFirstSearch records a skip reason when ChEMBL mapping fails, and does not invent a target", async () => {
    const targets = [{ symbol: "NOPE", name: "unmappable target", ensemblId: "ENSG_NOPE", targetScore: 0.5 }];
    const deps = {
      mapTargetToChembl: async () => ({ chemblId: null, confidence: "none", reason: "no confident match" }),
      fetchRawBioactivities: async () => [],
    };
    const result = await TP.runGreedyBestFirstSearch({ diseaseId: "EFO_X", diseaseName: "X", targets, w1: 0.5, w2: 0.5, maxCompoundsPerTarget: 5, includeKd: false, deps });
    assert.strictEqual(result.candidates.length, 0);
    assert.strictEqual(result.skippedTargets.length, 1);
    assert.ok(/no confident match/.test(result.skippedTargets[0].reason));
  });

  await test("runGreedyBestFirstSearch's goal test can reject a record after it enters the frontier (transparent exclusion, not silent)", async () => {
    const targets = [{ symbol: "T1", name: "target one", ensemblId: "ENSG_1", targetScore: 0.7 }];
    const deps = {
      mapTargetToChembl: async () => ({ chemblId: "CHEMBL_T1", confidence: "high", reason: "test" }),
      fetchRawBioactivities: async () => [
        { molecule_chembl_id: "CHEMBL_GOOD", standard_type: "IC50", standard_value: 10, standard_units: "nM", standard_relation: "=", pchembl_value: 8, data_validity_comment: null },
        { molecule_chembl_id: "CHEMBL_BAD", standard_type: "IC50", standard_value: 10, standard_units: "mg/mL", standard_relation: "=", pchembl_value: null, data_validity_comment: null },
      ],
    };
    const result = await TP.runGreedyBestFirstSearch({ diseaseId: "EFO_Y", diseaseName: "Y", targets, w1: 0.5, w2: 0.5, maxCompoundsPerTarget: 5, includeKd: false, deps });
    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.candidates[0].compoundId, "CHEMBL_GOOD");
    assert.strictEqual(result.excludedRecords.length, 1);
    assert.strictEqual(result.excludedRecords[0].moleculeId, "CHEMBL_BAD");
  });

  await test("explore() surfaces disease-search errors distinctly from target/bioactivity errors (stage tagging)", async () => {
    TP.__setFetchForTests(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    try {
      await TP.explore({ disease: "some disease", onStep: () => {} });
      assert.fail("expected explore() to throw");
    } catch (e) {
      assert.strictEqual(e.stage, "disease_search");
    }
  });

  await test("explore() never silently substitutes a different disease when the search fails to find one", async () => {
    TP.__setFetchForTests(async () => jsonResponse({ data: { search: { hits: [] } } }));
    try {
      await TP.explore({ disease: "totally unknown condition xyz", onStep: () => {} });
      assert.fail("expected explore() to throw notFound");
    } catch (e) {
      assert.strictEqual(e.notFound, true);
    }
  });

  await test("runDemoExplore runs the real GBFS engine (produces a heuristic-ordered log) against the recorded snapshot", async () => {
    const result = await TP.runDemoExplore({ w1: 0.5 });
    assert.strictEqual(result.demoMode, true);
    assert.ok(result.candidates.length > 0);
    assert.strictEqual(result.algorithm, "Greedy Best-First Search");
    // APP has the highest target score among demo targets and is mapped -> should be expanded first.
    const firstTargetStep = result.log.find((l) => l.kind === "target");
    assert.strictEqual(firstTargetStep.label, "APP");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
