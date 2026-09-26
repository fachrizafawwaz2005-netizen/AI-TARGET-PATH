# TargetPath — Disease → Target → Compound (Greedy Best-First Search)

## 0. Important disclosure — please read this first

Your instructions describe a project with `app.py`, `backend/search_engine.py`,
`requirements.txt`, and `run.bat`. **The ZIP you uploaded (`targetpath-static (2).zip`)
does not contain any of those files.** It contains a purely client-side,
static web app:

```
targetpath-static/
  index.html
  assets/pipeline.js   <- all "backend" logic (Open Targets + ChEMBL calls, ranking)
  assets/ui.js         <- rendering / DOM interaction
  assets/style.css
```

There is no Python backend anywhere in the ZIP — every API call already happened
directly from the browser via `fetch()`, and there was no `run.bat` or
`requirements.txt` to begin with. I did **not** invent a Python backend to
match the description, because that would mean fabricating a project
structure that was never given to me. Instead, I fixed the actual project
that was uploaded, in place, and added the Python-based launcher
(`server.py` + `run.bat` + `requirements.txt`) as a *thin static file server*
so it still runs the way your instructions describe (double-click `run.bat`
on Windows). If you do have a separate `app.py` / `backend/` project that
didn't make it into this ZIP, send it and I'll fix that one directly instead.

Everything below describes what was actually changed in the project that
was actually uploaded.

## 1. What was wrong, and what was fixed

| # | Problem in the uploaded code | Fix |
|---|---|---|
| 1 | Frontend had a BFS / DFS / UCS selector (`#algo-buttons`, `.alg-btn`) that changed `state.algorithm` and called `bfs()`/`dfs()`/`ucs()`. | Selector removed entirely. `pipeline.js` now implements **one** algorithm, `runGreedyBestFirstSearch()`. There is no code path that runs anything else. |
| 2 | The old "search" ran **after** all data was already fetched and simply traversed a pre-built static graph — i.e. fetch-everything-then-traverse, mislabeled as a search algorithm. | The new GBFS **is** the fetch loop: a priority queue decides which target to map/fetch bioactivity for next, and which compound to goal-test next. Nothing is fetched before its frontier item is popped. See §2. |
| 3 | `cariIdPenyakit()` always took `hits[0]`. | `fetchDiseaseHits()` now returns all candidates; `decideDiseaseSelection()` auto-picks only on an exact name match or a single hit, otherwise returns `ambiguous` and the UI shows a picker so you choose. Never silently substitutes a different disease, never defaults to Alzheimer's. |
| 4 | Target retrieval was hard-capped at a small fixed size. | `nTarget` is now a UI slider (5–30, default 15) passed straight into the Open Targets query. |
| 5 | ChEMBL target mapping (`cariChemblTargetId`) took the first hit from a text search — any organism, any type. | `mapTargetToChembl()` now queries by both gene symbol and name, restricts to **Homo sapiens**, scores **SINGLE PROTEIN** + exact name matches higher, and returns `chemblId: null` with a stated reason when nothing is confident — it never guesses. |
| 6 | Bioactivity only handled `IC50`. Mixed units/relations were not checked. | `evaluateActivityQuality()` now accepts **IC50 and Ki** (optionally **Kd** via a checkbox), converts `nM/µM/pM` to a common `nM` basis, requires an exact relation (`=`) or a ChEMBL-provided `pchembl_value`, and rejects records flagged by ChEMBL's own `data_validity_comment` — every rejection carries a human-readable reason, shown in the UI, not hidden. |
| 7 | On any failure, the app silently rendered a hard-coded Alzheimer's demo dataset as if it were live. | Demo Mode is now **only** triggered by an explicit "Run Demo Example" button, always labeled `DEMO MODE — not live data`, and reuses the exact same GBFS engine against a recorded snapshot (so the demo is honest about which algorithm is running). Live failures show a stage-tagged error banner instead (see §4) and never fall back to demo data automatically. |
| 8 | No visibility into *why* a target had no compounds, or why a compound record was dropped. | New "Targets Skipped" and "Bioactivity Records Excluded" panels list every skip/exclusion with its reason. Summary stat chips show targets checked / mapped, records examined / passed / excluded. |
| 9 | No way to see the algorithm's actual exploration order/reasoning. | New step-by-step exploration log (`#gbfs-log`) shows, for every frontier pop: step number, node type, heuristic value, and what happened (expanded / unmapped / goal test passed / goal test failed). |

## 2. The Greedy Best-First Search, precisely

**Initial state**: the disease, once identified (a specific Open Targets EFO/MONDO id + name).

**Nodes**: `disease` → `target` → `compound`.

**Actions**:
- *Expand a target node*: map the target (gene symbol + name) to a ChEMBL
  target id, then fetch its raw bioactivity records (bounded by the
  "max compound records per target" setting).
- *Goal-test a compound node*: validate one raw bioactivity record against
  the system's data-quality criteria (see §3).

**Frontier**: a priority queue. At every step the item with the **highest
heuristic value** is popped — never the oldest-inserted item (that would be
BFS), never the most recently-inserted item (DFS), and never the item with
the lowest *accumulated path cost* (that would be Uniform-Cost Search, which
this project intentionally does not use — GBFS orders purely by heuristic).

**Heuristic**:
```
h = w1 x target_association_score + w2 x (pActivity / 12)
```
- `target_association_score` comes directly from Open Targets (0–1).
- `pActivity` is `-log10(molar potency)` (ChEMBL's own `pChEMBL` convention);
  dividing by 12 is a soft normalization (potency rarely exceeds ~12,
  i.e. sub-picomolar) and the contribution is clamped to `[0, 1]`. This is a
  scaling convenience for combining two differently-scaled signals, **not**
  a scientific claim, and the resulting score is a search/ranking priority —
  never described anywhere in the app as a probability of clinical success.
- An **unexpanded target**'s compounds (and their real `pActivity`) are not
  known yet, so it is given an *optimistic* priority
  `w1 x target_score + w2 x 1.0` (best-case future bioactivity). This keeps
  target items comparable, on the same scale, to compound items already
  sitting in the frontier, and is documented in `pipeline.js` as an upper
  bound, not a prediction.

**Duplicate / cycle avoidance**: a `visited` set keyed by node id
(`target:SYMBOL`, `compound:CHEMBL_ID`). A compound reachable from two
different targets is only goal-tested once.

**Goal test**: `evaluateActivityQuality()` — applied when a compound node is
**popped**, not before. A record can still be rejected at this point even
though it was already sitting in the frontier; every rejection is logged
with its reason (see the "goal test FAILED" rows in the exploration log and
the "Bioactivity Records Excluded" panel).

**Recording results**: every frontier pop is appended to `log[]` with a step
number, node id, heuristic value, and outcome. `exploredOrder` is the
sequence of node ids in the order they were actually popped. The
"Prioritized Research Candidates" table is a **separate**, clearly-labeled
re-sort of the goals GBFS found, by final heuristic score — it is not used
to fake the exploration order, and the UI shows both the log and the table
side by side so this distinction is visible.

## 3. Data-quality criteria used (goal test), stated explicitly

A raw ChEMBL activity record is accepted only if **all** of the following hold:
1. `standard_type` is `IC50` or `Ki` (and `Kd`, only if you tick "also consider Kd").
2. `standard_value` is a positive number.
3. `standard_units` is one of `nM`, `µM`/`uM`, `pM`, `mM` (converted to a common nM basis) — anything else is excluded with a stated reason, not silently dropped.
4. `data_validity_comment` is empty or exactly `"Manually validated"` — anything else ChEMBL itself flagged (e.g. "Outside typical range") is excluded.
5. Either ChEMBL already provides a validated `pchembl_value`, **or** `standard_relation` is exactly `"="` (a `>`/`<`/`>=` relation without a ChEMBL-provided pChEMBL is excluded, since it is not an exact measurement).

There is **no** universal potency threshold (e.g. no hard-coded "Ki < 100 nM
is a hit"). The only knobs are the w1/w2 heuristic weights, which you control
in the UI and which are shown next to every score.

## 4. Error handling / no silent demo fallback

Every live failure is tagged with a `stage`:
`disease_search` and `target_retrieval` are Open Targets; `target_mapping_and_bioactivity`
is ChEMBL. The UI shows an error banner naming the source and the stage — it
never silently substitutes demo data. Demo Mode only ever runs when you
click "Run Demo Example".

## 5. Testing performed

**This sandbox's network access does not include
`api.platform.opentargets.org` or `www.ebi.ac.uk`**, so no live API call
could be made from here. What was actually run:

- `tests/test_gbfs.js` — 21 unit tests against **mocked** fetch responses,
  covering: unit conversion, heuristic math (incl. clamping and the
  optimistic-bound property), the full quality/goal-test matrix (accept,
  wrong type, wrong relation, flagged validity, Kd on/off), disease
  disambiguation (exact match / ambiguous / not-found — never a silent
  Alzheimer fallback), ChEMBL mapping (organism/type scoring, not
  first-hit), GBFS exploration order (higher-heuristic target expands
  first; a compound shared by two targets is only counted once), a
  target-mapping failure being recorded with a reason, a compound
  entering the frontier and then failing the goal test at pop time, and
  stage-tagged error propagation. **All 21 passed.**
- `tests/test_disease_matrix.js` — runs the full `explore()` pipeline
  end-to-end against distinct mocked fixtures for the 5 required diseases
  (Alzheimer disease, Parkinson disease, Type 2 diabetes mellitus, Breast
  cancer, Epilepsy), asserting the correct EFO id, correct target-mapping
  count, correct candidate count, that Epilepsy's "mapped but no
  bioactivity" case renders 0 candidates rather than fabricated ones, and
  that no other disease leaks the Alzheimer fixture's compound.
  **All 5 passed.**
- `tests/test_ui_smoke.js` and `tests/test_ui_live_flow.js` — jsdom-based
  tests that load the real `index.html`/`pipeline.js`/`ui.js` and drive
  the actual DOM: Demo Mode end-to-end rendering, the ambiguous-disease
  picker appearing and being clickable, and a mocked Open Targets outage
  producing a visible stage-tagged error banner with no automatic demo
  fallback. **All passed** (require `npm install` first — see below;
  not required for the app itself).

**What this does NOT prove**: that the real Open Targets GraphQL schema or
the real ChEMBL REST schema exactly match the mocked fixtures above. The
query shapes and field names (`associatedTargets`, `pchembl_value`,
`standard_relation`, `target_synonym__icontains`, etc.) were cross-checked
against Open Targets' and ChEMBL's published API documentation, but I could
not execute a single real request against either service from this
environment. Please treat the first live run as the actual verification of
the schema assumptions, and if a field name has drifted, the error banner
will tell you which stage failed.

Run the no-dependency test suite yourself:
```
node tests/test_gbfs.js
node tests/test_disease_matrix.js
# or:
npm test
```

## 6. How to run TargetPath (Windows, no coding required)

1. Install Python 3 if you don't have it: https://www.python.org/downloads/
   — during setup, tick **"Add python.exe to PATH"**.
2. Unzip this project anywhere (e.g. your Desktop).
3. Double-click **`run.bat`**.
   - It checks for Python, then starts a small local server (no packages to
     install — see `requirements.txt`), and opens TargetPath in your browser
     at `http://localhost:8000`.
   - Keep the black console window open while you use the app; closing it
     stops the server.
4. In the app: click **Start Exploration**, type a disease name, click
   **Run Exploration (Live)**. Use **Run Demo Example** any time you're
   offline or want a fast, guaranteed walkthrough of the algorithm (always
   labeled DEMO).

If you'd rather not use `run.bat`, opening `index.html` directly may also
work, but some browsers block `fetch()` from `file://` pages — the server is
the reliable option.

## 7. Files in this ZIP

```
index.html              Single-page app shell
assets/pipeline.js      Open Targets + ChEMBL calls, GBFS engine, heuristic, quality filter
assets/ui.js            DOM rendering / interaction (no algorithm logic here)
assets/style.css        Original visual design, extended with a few new components
server.py               Stdlib-only static file server (the "run" mechanism)
run.bat                 Windows launcher (checks Python, runs server.py, opens browser)
requirements.txt        States that no external packages are required
package.json            npm test scripts for the Node-based test suite (optional)
tests/test_gbfs.js               Unit tests (no dependencies)
tests/test_disease_matrix.js     5-disease integration test (no dependencies)
tests/test_ui_smoke.js           jsdom UI test (optional, needs `npm install`)
tests/test_ui_live_flow.js       jsdom UI test (optional, needs `npm install`)
README.md               This file
```

No files from the original ZIP were deleted — `index.html`, `assets/pipeline.js`,
`assets/ui.js`, and `assets/style.css` were rewritten in place; nothing else existed.

## 8. Known limitations / not yet verified

- No live call to Open Targets or ChEMBL has actually been made (see §5) —
  the first real run is the real verification.
- ChEMBL's `target.json` list endpoint doesn't reliably expose every gene
  synonym in one field; `mapTargetToChembl()`'s scoring is a best effort
  (symbol/name text match + organism/type filtering) and will mark a target
  `ambiguous` or `unmapped` with a stated reason rather than silently
  guessing, but a confident-looking match is not a guarantee of biological
  correctness — please spot-check important results against
  https://www.ebi.ac.uk/chembl/ directly.
- The `w2 x (pActivity/12)` normalization and the optimistic target-frontier
  bound are documented, explainable design choices (§2–§3), not universal
  pharmacological standards.
