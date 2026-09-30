/* jsdom test for the LIVE-mode UI flow using a mocked window.fetch:
 *  1. An ambiguous disease search shows the disease picker (not an
 *     auto-guess), and clicking a candidate re-runs with that exact id.
 *  2. A failing Open Targets call surfaces a stage-tagged error banner.
 * Run with: node tests/test_ui_live_flow.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

function otSearchResponse(hits) {
  return { ok: true, status: 200, json: async () => ({ data: { search: { hits } } }) };
}

async function setup() {
  const root = __dirname;
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/index.html" });
  const { window } = dom;
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  return { dom, window };
}

async function testAmbiguousDiseasePicker() {
  const { window } = await setup();

  let callCount = 0;
  window.fetch = async (url, opts) => {
    callCount += 1;
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (String(body.query || "").includes("search(")) {
      return otSearchResponse([
        { id: "EFO_0000305", name: "breast carcinoma", entity: "disease" },
        { id: "EFO_0000313", name: "breast cancer", entity: "disease" },
      ]);
    }
    if (String(body.query || "").includes("associatedTargets")) {
      return { ok: true, status: 200, json: async () => ({ data: { disease: { associatedTargets: { rows: [] } } } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  window.eval(fs.readFileSync(path.join(__dirname, "pipeline.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(__dirname, "ui.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 20));

  const doc = window.document;
  const byId = (id) => doc.getElementById(id);

  byId("start-btn").dispatchEvent(new window.Event("click"));
  byId("disease-input").value = "breast cancer type";
  byId("run-btn").dispatchEvent(new window.Event("click"));

  let tries = 0;
  while (byId("disease-picker").style.display === "none" && tries < 50) {
    await new Promise((r) => setTimeout(r, 20));
    tries += 1;
  }

  const pickerVisible = byId("disease-picker").style.display !== "none";
  const buttons = doc.querySelectorAll("#disease-picker .picker-btn");
  console.log(`${pickerVisible ? "  ok " : "FAIL"} - ambiguous disease search shows a picker instead of guessing`);
  console.log(`${buttons.length === 2 ? "  ok " : "FAIL"} - picker lists both candidate diseases`);

  // Click the second candidate ("breast cancer") and confirm it re-runs
  // with that EXACT disease, not silently defaulting to something else.
  buttons[1].dispatchEvent(new window.Event("click"));
  tries = 0;
  while (byId("results").style.display === "none" && tries < 50) {
    await new Promise((r) => setTimeout(r, 20));
    tries += 1;
  }
  const nameOk = byId("disease-name").textContent === "breast cancer";
  console.log(`${nameOk ? "  ok " : "FAIL"} - selecting a candidate re-runs with that exact disease`);

  return pickerVisible && buttons.length === 2 && nameOk;
}

async function testStageTaggedError() {
  const { window } = await setup();
  window.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

  window.eval(fs.readFileSync(path.join(__dirname, "pipeline.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(__dirname, "ui.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 20));

  const doc = window.document;
  const byId = (id) => doc.getElementById(id);
  byId("start-btn").dispatchEvent(new window.Event("click"));
  byId("disease-input").value = "epilepsy";
  byId("run-btn").dispatchEvent(new window.Event("click"));

  let tries = 0;
  while (byId("error-box").style.display === "none" && tries < 50) {
    await new Promise((r) => setTimeout(r, 20));
    tries += 1;
  }
  const errVisible = byId("error-box").style.display !== "none";
  const mentionsOpenTargets = /Open Targets/.test(byId("error-box").textContent);
  const mentionsStage = /disease_search/.test(byId("error-box").textContent);
  const demoNotAutoShown = byId("demo-box").style.display === "none";
  console.log(`${errVisible ? "  ok " : "FAIL"} - Open Targets failure shows a visible error banner`);
  console.log(`${mentionsOpenTargets ? "  ok " : "FAIL"} - error banner names the failing data source (Open Targets)`);
  console.log(`${mentionsStage ? "  ok " : "FAIL"} - error banner names the failing stage`);
  console.log(`${demoNotAutoShown ? "  ok " : "FAIL"} - demo data was NOT silently shown after the live failure`);

  return errVisible && mentionsOpenTargets && mentionsStage && demoNotAutoShown;
}

async function main() {
  console.log("Ambiguous disease picker flow:");
  const r1 = await testAmbiguousDiseasePicker();
  console.log("\nStage-tagged error / no silent demo fallback:");
  const r2 = await testStageTaggedError();
  const ok = r1 && r2;
  console.log(`\n${ok ? "ALL PASSED" : "SOME FAILED"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("Live-flow UI test crashed:", e);
  process.exit(1);
});
