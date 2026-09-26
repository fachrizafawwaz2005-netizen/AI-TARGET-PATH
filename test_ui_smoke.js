/* UI smoke test using jsdom. Loads the real index.html/pipeline.js/ui.js,
 * runs Demo Mode end-to-end (since it needs no network), and checks that
 * the DOM actually updates: candidates table, exploration log, summary
 * stats, and DEMO badge. This is NOT a live-API test (no network access in
 * this environment) — see README for what was and was not verified live.
 * Run with: node tests/test_ui_smoke.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

async function main() {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "http://localhost/index.html" });
  const { window } = dom;

  // jsdom doesn't implement requestAnimationFrame by default.
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  const pipelineSrc = fs.readFileSync(path.join(root, "assets", "pipeline.js"), "utf8");
  const uiSrc = fs.readFileSync(path.join(root, "assets", "ui.js"), "utf8");
  window.eval(pipelineSrc);
  window.eval(uiSrc);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const doc = window.document;
  const byId = (id) => doc.getElementById(id);

  // Navigate to exploration page and trigger the Demo button.
  byId("start-btn").dispatchEvent(new window.Event("click"));
  byId("demo-btn").dispatchEvent(new window.Event("click"));

  // Wait for the async demo run to finish rendering.
  let tries = 0;
  while (byId("results").style.display === "none" && tries < 50) {
    await new Promise((r) => setTimeout(r, 20));
    tries += 1;
  }

  const checks = [];
  function check(name, cond) {
    checks.push({ name, ok: !!cond });
  }

  check("results section became visible", byId("results").style.display !== "none");
  check("demo badge shown", byId("demo-box").style.display !== "none" && /DEMO/.test(byId("demo-box").textContent));
  check("disease name rendered", byId("disease-name").textContent.includes("Alzheimer"));
  check("candidates table has rows", byId("candidates-tbody").children.length > 0);
  check("exploration log has entries", byId("gbfs-log").children.length > 0);
  check("summary stats rendered", /targets checked/.test(byId("summary-stats").textContent));
  check("fixed GBFS label present, no BFS/DFS/UCS selector", !doc.querySelector(".alg-btn:not(.fixed)"));
  // BFS/DFS/UCS may still appear in explanatory prose (contrasting GBFS with
  // what it is NOT) — what must not exist is a clickable selector/button for them.
  check(
    "no clickable BFS/DFS/UCS algorithm button anywhere",
    Array.from(doc.querySelectorAll("button")).every((b) => !/^(BFS|DFS|UCS)$/.test(b.textContent.trim()))
  );

  let passed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "  ok " : "FAIL"} - ${c.name}`);
    if (c.ok) passed += 1;
  }
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((e) => {
  console.error("UI smoke test crashed:", e);
  process.exit(1);
});
