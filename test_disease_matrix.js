/* Runs the FULL explore() pipeline (disease search -> associated targets ->
 * ChEMBL mapping -> bioactivity -> GBFS) for the 5 diseases required by the
 * task, against MOCKED fixtures shaped like the real Open Targets / ChEMBL
 * APIs. This environment has no network access to api.platform.opentargets.org
 * or www.ebi.ac.uk, so this is explicitly a mocked/fixture run, not a live
 * run — see README "Testing" section for what this does and does not prove.
 * Run with: node tests/test_disease_matrix.js
 */
"use strict";
const assert = require("assert");
const path = require("path");
const TP = require(path.join(__dirname, "pipeline.js"));

// ---------------------------------------------------------------------
// Fixture data: one distinct disease/target/compound set per test case,
// so a bug that leaked Alzheimer's demo data into another disease would
// be caught immediately (assertions check exact ids per case below).
// ---------------------------------------------------------------------
const FIXTURES = {
  "Alzheimer disease": {
    efoId: "MONDO_0004975",
    diseaseHits: [{ id: "MONDO_0004975", name: "Alzheimer disease", entity: "disease" }],
    targets: [
      { id: "ENSG00000142192", approvedSymbol: "APP", approvedName: "amyloid beta precursor protein" },
      { id: "ENSG00000080815", approvedSymbol: "PSEN1", approvedName: "presenilin 1" },
    ],
    scores: { APP: 0.87, PSEN1: 0.81 },
    chembl: { APP: "CHEMBL237", PSEN1: null },
    activities: {
      CHEMBL237: [{ molecule_chembl_id: "CHEMBL343246", standard_type: "IC50", standard_value: 3.5, standard_units: "nM", standard_relation: "=", pchembl_value: 8.46, data_validity_comment: null }],
    },
  },
  "Parkinson disease": {
    efoId: "MONDO_0005180",
    diseaseHits: [{ id: "MONDO_0005180", name: "Parkinson disease", entity: "disease" }],
    targets: [
      { id: "ENSG00000145335", approvedSymbol: "SNCA", approvedName: "synuclein alpha" },
      { id: "ENSG00000188906", approvedSymbol: "LRRK2", approvedName: "leucine rich repeat kinase 2" },
    ],
    scores: { SNCA: 0.7, LRRK2: 0.9 },
    chembl: { SNCA: null, LRRK2: "CHEMBL5465" },
    activities: {
      CHEMBL5465: [{ molecule_chembl_id: "CHEMBL3623927", standard_type: "IC50", standard_value: 12, standard_units: "nM", standard_relation: "=", pchembl_value: 7.92, data_validity_comment: null }],
    },
  },
  "Type 2 diabetes mellitus": {
    efoId: "MONDO_0005148",
    diseaseHits: [{ id: "MONDO_0005148", name: "Type 2 diabetes mellitus", entity: "disease" }],
    targets: [
      { id: "ENSG00000132170", approvedSymbol: "PPARG", approvedName: "peroxisome proliferator activated receptor gamma" },
      { id: "ENSG00000171105", approvedSymbol: "INSR", approvedName: "insulin receptor" },
    ],
    scores: { PPARG: 0.75, INSR: 0.6 },
    chembl: { PPARG: "CHEMBL235", INSR: null },
    activities: {
      CHEMBL235: [{ molecule_chembl_id: "CHEMBL709", standard_type: "Ki", standard_value: 45, standard_units: "nM", standard_relation: "=", pchembl_value: 7.35, data_validity_comment: null }],
    },
  },
  "Breast cancer": {
    efoId: "MONDO_0007254",
    diseaseHits: [{ id: "MONDO_0007254", name: "breast cancer", entity: "disease" }],
    targets: [
      { id: "ENSG00000091831", approvedSymbol: "ESR1", approvedName: "estrogen receptor 1" },
      { id: "ENSG00000141736", approvedSymbol: "ERBB2", approvedName: "erb-b2 receptor tyrosine kinase 2" },
    ],
    scores: { ESR1: 0.92, ERBB2: 0.88 },
    chembl: { ESR1: "CHEMBL206", ERBB2: "CHEMBL1824" },
    activities: {
      CHEMBL206: [{ molecule_chembl_id: "CHEMBL1082", standard_type: "IC50", standard_value: 2.1, standard_units: "nM", standard_relation: "=", pchembl_value: 8.68, data_validity_comment: null }],
      CHEMBL1824: [{ molecule_chembl_id: "CHEMBL444", standard_type: "IC50", standard_value: 9.5, standard_units: "nM", standard_relation: "=", pchembl_value: 8.02, data_validity_comment: null }],
    },
  },
  Epilepsy: {
    efoId: "MONDO_0005027",
    diseaseHits: [{ id: "MONDO_0005027", name: "epilepsy", entity: "disease" }],
    targets: [{ id: "ENSG00000144285", approvedSymbol: "SCN1A", approvedName: "sodium voltage-gated channel alpha subunit 1" }],
    scores: { SCN1A: 0.65 },
    chembl: { SCN1A: "CHEMBL4296" },
    activities: {}, // mapped, but ChEMBL returns no matching bioactivity -> must show empty, not fabricated data
  },
};

function makeMockFetch(fixture) {
  return async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && /search\(/.test(body.query)) {
      return { ok: true, status: 200, json: async () => ({ data: { search: { hits: fixture.diseaseHits } } }) };
    }
    if (body && /associatedTargets/.test(body.query)) {
      const rows = fixture.targets.map((t) => ({ target: t, score: fixture.scores[t.approvedSymbol] }));
      return { ok: true, status: 200, json: async () => ({ data: { disease: { associatedTargets: { rows } } } }) };
    }
    if (String(url).includes("target.json")) {
      const symbolMatch = Object.keys(fixture.chembl).find((sym) => String(url).includes(encodeURIComponent(sym)) || String(url).toLowerCase().includes(sym.toLowerCase()));
      const chemblId = symbolMatch ? fixture.chembl[symbolMatch] : null;
      if (!chemblId) return { ok: true, status: 200, json: async () => ({ targets: [] }) };
      return { ok: true, status: 200, json: async () => ({ targets: [{ target_chembl_id: chemblId, organism: "Homo sapiens", target_type: "SINGLE PROTEIN", pref_name: symbolMatch }] }) };
    }
    if (String(url).includes("activity.json")) {
      const m = String(url).match(/target_chembl_id=([^&]+)/);
      const chemblTargetId = m ? decodeURIComponent(m[1]) : null;
      return { ok: true, status: 200, json: async () => ({ activities: fixture.activities[chemblTargetId] || [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function main() {
  console.log("Disease matrix integration test (mocked fixtures, no live network)\n");
  let passed = 0;
  let failed = 0;

  for (const [diseaseName, fixture] of Object.entries(FIXTURES)) {
    try {
      TP.__setFetchForTests(makeMockFetch(fixture));
      const result = await TP.explore({ disease: diseaseName, nTarget: 15, nCompoundPerTarget: 8, w1: 0.5, includeKd: false, onStep: () => {} });

      assert.strictEqual(result.disease.id, fixture.efoId, `disease id must match fixture for "${diseaseName}"`);
      assert.strictEqual(result.disease.name, fixture.diseaseHits[0].name, "disease name must match what was actually found");
      assert.strictEqual(result.algorithm, "Greedy Best-First Search");

      const mappedTargets = Object.entries(fixture.chembl).filter(([, id]) => id).map(([sym]) => sym);
      assert.strictEqual(result.stats.targetsMapped, mappedTargets.length, `expected ${mappedTargets.length} mapped target(s) for "${diseaseName}"`);

      const expectedCompoundCount = Object.values(fixture.activities).reduce((acc, list) => acc + list.length, 0);
      assert.strictEqual(result.candidates.length, expectedCompoundCount, `expected ${expectedCompoundCount} candidate(s) for "${diseaseName}"`);

      if (diseaseName === "Epilepsy") {
        assert.strictEqual(result.candidates.length, 0, "Epilepsy fixture has no bioactivity — must show 0 candidates, not fabricated ones");
        assert.ok(result.skippedTargets.length >= 1, "Epilepsy: the mapped-but-empty target must be recorded in skippedTargets with a reason");
      }
      if (diseaseName !== "Alzheimer disease") {
        assert.ok(!result.candidates.some((c) => c.compoundId === "CHEMBL343246"), `"${diseaseName}" must not leak the Alzheimer demo compound`);
      }

      console.log(`  ok  - ${diseaseName}: disease=${result.disease.id}, targetsMapped=${result.stats.targetsMapped}, candidates=${result.candidates.length}`);
      passed += 1;
    } catch (e) {
      console.log(`FAIL  - ${diseaseName}: ${e.message}`);
      failed += 1;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
