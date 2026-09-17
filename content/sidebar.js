(function () {
  if (window.__docuraHealthInjected) return;
  window.__docuraHealthInjected = true;

  const hostname = location.hostname;
  let site = { requirementsTable: null, listMapping: null, claimCache: {} };
  let panelOpen = false;
  let pickKind = null; // null | 'reqStatus' | 'reqDesc' | 'listLink' | 'listStatus'
  let pendingReqTable = null; // { tableSelector, statusColIndex } while mid-way through the 2-step requirements picker
  let pendingListMapping = null; // { rowsSelector, colIndex } while mid-way through the 2-step list picker
  let autoScanStarted = false; // ensures the full-page auto-scan only ever kicks off once per page load
  let refreshTimer = null;

  const host = document.createElement("div");
  host.id = "docura-health-host";
  host.style.all = "initial";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
    <style>${STYLES()}</style>
    <button id="tab" part="tab">
      <span class="tab-label">Docura Health</span>
      <span id="badge" class="badge" hidden>0</span>
    </button>
    <div id="panel" class="panel">
      <div class="panel-header">
        <strong>Docura Health</strong>
        <span class="host">${escapeHtml(hostname)}</span>
        <div class="spacer"></div>
        <button id="refreshBtn" title="Refresh">↻</button>
        <button id="settingsBtn" title="Manage all sites">⚙</button>
        <button id="closeBtn" title="Close">✕</button>
      </div>
      <div class="panel-body" id="panelBody"></div>
    </div>
    <div id="pickBanner" class="pick-banner" hidden></div>
  `;

  const el = (id) => root.getElementById(id);

  el("tab").addEventListener("click", () => togglePanel());
  el("closeBtn").addEventListener("click", () => togglePanel(false));
  el("refreshBtn").addEventListener("click", () => refresh());
  el("settingsBtn").addEventListener("click", () => {
    try {
      chrome.runtime.sendMessage({ type: "docura:openOptions" });
    } catch (e) {
      /* no-op if messaging unavailable */
    }
  });

  window.addEventListener("docura:toggle", () => togglePanel());

  function togglePanel(force) {
    panelOpen = typeof force === "boolean" ? force : !panelOpen;
    el("panel").classList.toggle("open", panelOpen);
    if (panelOpen) refresh();
  }

  async function load() {
    site = await window.DocuraStorage.getSite(hostname);
    site.requirementsTable = site.requirementsTable || null;
    site.listMapping = site.listMapping || null;
    site.claimCache = site.claimCache || {};
    refresh();
  }

  function refresh() {
    const { found: reqFound, outstanding: reqOutstanding } = computeOutstandingForCurrentPage();
    const overview = computeListOverview();
    const badgeCount = reqFound ? reqOutstanding.length : overview ? overview.pending.length : 0;

    const badge = el("badge");
    if (badgeCount > 0) {
      badge.hidden = false;
      badge.textContent = String(badgeCount);
    } else {
      badge.hidden = true;
    }

    maybeUpdateClaimCache();
    annotateListRows();
    maybeAutoScanList();

    if (panelOpen) renderPanel();
  }

  // ---------- Requirements tracking (learn-as-you-go) ----------

  function extractOutstanding(doc, requirementsTable) {
    const { tableSelector, statusColIndex, descColIndex } = requirementsTable;
    let table;
    try {
      table = doc.querySelector(tableSelector);
    } catch {
      table = null;
    }
    if (!table) {
      // Some claims render plain text ("No requirements entered.") instead of
      // a table when there's nothing to show — that's a real, legitimate
      // "zero outstanding" answer, not a failure to find the data.
      const bodyText = (doc.body && doc.body.innerText ? doc.body.innerText : "").toLowerCase();
      if (bodyText.includes("no requirements entered") || bodyText.includes("no requirements found") || bodyText.includes("no pending requirements")) {
        return { found: true, outstanding: [], totalDataRows: 0 };
      }
      return { found: false, outstanding: [], totalDataRows: 0 };
    }

    const outstanding = [];
    let totalDataRows = 0;
    for (const row of table.querySelectorAll("tr")) {
      const cells = row.children;
      if (cells.length <= Math.max(statusColIndex, descColIndex)) continue;
      const statusCell = cells[statusColIndex];
      const descCell = cells[descColIndex];
      if (statusCell.tagName === "TH" || descCell.tagName === "TH") continue; // header row, not a data row
      totalDataRows++;
      const status = (statusCell.innerText || statusCell.textContent || "").trim().toLowerCase();
      const desc = (descCell.innerText || descCell.textContent || "").trim();
      if (status === "open" && desc) outstanding.push(desc);
    }
    return { found: true, outstanding, totalDataRows };
  }

  function computeOutstandingForCurrentPage() {
    if (!site.requirementsTable) return { found: false, outstanding: [], totalDataRows: 0 };
    return extractOutstanding(document, site.requirementsTable);
  }

  async function maybeUpdateClaimCache() {
    const { found, outstanding, totalDataRows } = computeOutstandingForCurrentPage();
    if (!found) return; // requirements table isn't on this page/tab right now — don't overwrite what we already know
    const key = location.pathname;
    const existing = site.claimCache[key];
    if (existing && JSON.stringify(existing.outstanding) === JSON.stringify(outstanding) && existing.totalDataRows === totalDataRows) return;
    site.claimCache[key] = { outstanding, totalDataRows, checkedAt: Date.now() };
    await window.DocuraStorage.saveSite(hostname, site);
  }

  function waitFor(fn, tries, intervalMs) {
    return new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        const val = fn();
        if (val) return resolve(val);
        n++;
        if (n >= tries) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // Finds the clickable "Requirements" tab inside another claim's page (loaded
  // in a hidden same-origin iframe), the same way a person would find it.
  function findRequirementsTabButton(doc) {
    const all = doc.querySelectorAll("*");
    for (const el of all) {
      if (el.children.length > 0) continue; // leaf text nodes only
      if (el.textContent.trim().toLowerCase() === "requirements") {
        return el.closest("button, a, [role='tab'], li") || el;
      }
    }
    return null;
  }

  // On-demand: quietly load a single claim's page in a hidden same-origin
  // iframe, click its Requirements tab exactly like a person would, then read
  // the result — no navigation the user sees, no server API guessing.
  async function fetchAndCheckClaim(url) {
    if (!site.requirementsTable) return { ok: false, reason: "not-mapped" };

    return new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed; width:1px; height:1px; opacity:0; pointer-events:none; left:-9999px; top:-9999px;";
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        iframe.remove();
        resolve(result);
      };
      const timeout = setTimeout(() => finish({ ok: false, reason: "timeout" }), 20000);

      iframe.addEventListener("load", async () => {
        let idoc;
        try {
          idoc = iframe.contentDocument;
        } catch {
          return finish({ ok: false, reason: "cross-origin" });
        }
        if (!idoc) return finish({ ok: false, reason: "no-document" });

        let res = extractOutstanding(idoc, site.requirementsTable);
        if (!res.found) {
          const btn = await waitFor(() => findRequirementsTabButton(idoc), 30, 250);
          if (btn) {
            btn.click();
            res = (await waitFor(() => {
              const r = extractOutstanding(idoc, site.requirementsTable);
              return r.found ? r : null;
            }, 25, 250)) || { found: false, outstanding: [] };
          }
        }

        if (!res.found) return finish({ ok: false, reason: "not-found-after-tab-click" });

        const pathname = new URL(url, location.href).pathname;
        site.claimCache[pathname] = { outstanding: res.outstanding, totalDataRows: res.totalDataRows, checkedAt: Date.now() };
        await window.DocuraStorage.saveSite(hostname, site);
        finish({ ok: true, outstanding: res.outstanding, totalDataRows: res.totalDataRows });
      });

      iframe.src = url;
      document.body.appendChild(iframe);
    });
  }

  // ---------- Claims list annotation ----------

  function annotateListRows() {
    if (!site.listMapping) return;
    const { rowsSelector, colIndex, statusColIndex } = site.listMapping;
    let rowsContainer;
    try {
      rowsContainer = document.querySelector(rowsSelector);
    } catch {
      rowsContainer = null;
    }
    if (!rowsContainer) return;

    for (const row of rowsContainer.children) {
      if (row.tagName !== "TR") continue;
      const cell = row.children[colIndex];
      if (!cell) continue;
      const link = cell.querySelector("a");
      if (!link || !link.href) continue;

      let pathname;
      try {
        pathname = new URL(link.href, location.href).pathname;
      } catch {
        continue;
      }
      const cached = site.claimCache[pathname];
      const claimStatusText = readRowStatusText(row, statusColIndex);

      let badge = cell.querySelector(".docura-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "docura-badge";
        badge.title = "Click to check this claim's Requirements now, without opening it.";
        badge.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onBadgeClick(badge, link.href, row);
        });
        cell.appendChild(badge);
      }
      renderBadgeState(badge, cached, claimStatusText);
    }
  }

  function readRowStatusText(row, statusColIndex) {
    if (statusColIndex === undefined || statusColIndex === null) return null;
    const cell = row.children[statusColIndex];
    return cell ? (cell.innerText || cell.textContent || "").trim() : null;
  }

  function renderBadgeState(badge, cached, claimStatusText) {
    if (!cached) {
      badge.className = "docura-badge docura-badge-unknown";
      badge.textContent = "not checked yet";
      return;
    }
    if (cached.outstanding.length > 0) {
      badge.className = "docura-badge docura-badge-pending";
      badge.textContent = `${cached.outstanding.length} pending`;
      return;
    }
    const isStillOpen = claimStatusText && claimStatusText.toLowerCase().includes("open");
    if ((cached.totalDataRows || 0) === 0 && isStillOpen) {
      badge.className = "docura-badge docura-badge-none";
      badge.textContent = "no requirements listed";
    } else {
      badge.className = "docura-badge docura-badge-clear";
      badge.textContent = "clear";
    }
  }

  async function onBadgeClick(badge, url, row) {
    badge.className = "docura-badge docura-badge-unknown";
    badge.textContent = "checking…";
    const result = await fetchAndCheckClaim(url);
    if (!result.ok) {
      badge.textContent = "couldn't auto-check";
      showPopup(badge, [], url, false);
      return;
    }
    const claimStatusText = readRowStatusText(row, site.listMapping?.statusColIndex);
    renderBadgeState(badge, { outstanding: result.outstanding, totalDataRows: result.totalDataRows }, claimStatusText);
    showPopup(badge, result.outstanding, url, true);
  }

  // Runs once per page load: automatically checks every not-yet-known claim
  // visible on this list page, so badges fill in without any clicking.
  function maybeAutoScanList() {
    if (autoScanStarted) return;
    if (!site.listMapping || !site.requirementsTable) return;
    let rowsContainer;
    try {
      rowsContainer = document.querySelector(site.listMapping.rowsSelector);
    } catch {
      rowsContainer = null;
    }
    if (!rowsContainer) return;
    autoScanStarted = true;
    runAutoScan(rowsContainer, site.listMapping.colIndex);
  }

  async function runAutoScan(rowsContainer, colIndex) {
    const targets = [];
    for (const row of rowsContainer.children) {
      if (row.tagName !== "TR") continue;
      const cell = row.children[colIndex];
      const link = cell && cell.querySelector("a");
      if (!link || !link.href) continue;
      let pathname;
      try {
        pathname = new URL(link.href, location.href).pathname;
      } catch {
        continue;
      }
      if (site.claimCache[pathname]) continue; // already known, skip
      targets.push(link.href);
    }
    if (targets.length === 0) return;

    let idx = 0;
    const concurrency = 1; // sequential — more reliable than parallel background loads
    async function worker() {
      while (idx < targets.length) {
        const url = targets[idx++];
        await fetchAndCheckClaim(url);
        refresh(); // update page badges AND the sidebar overview live as each result lands
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  }

  function showPopup(anchorEl, outstanding, url, ok) {
    closePopup();
    const rect = anchorEl.getBoundingClientRect();
    const popup = document.createElement("div");
    popup.className = "docura-popup";
    popup.style.top = `${window.scrollY + rect.bottom + 6}px`;
    popup.style.left = `${window.scrollX + rect.left}px`;

    const body = !ok
      ? `<p>Couldn't automatically check this claim just now — it may have been slow to load. Click the badge again to retry, or <a href="${url}" target="_blank" rel="noopener">open it directly</a>.</p>`
      : outstanding.length === 0
      ? `<p>No open requirements — this claim looks clear.</p>`
      : `<ul>${outstanding.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`;

    popup.innerHTML = `
      <div class="docura-popup-head">Requirements status <button class="docura-popup-close" type="button">✕</button></div>
      ${body}
    `;
    document.body.appendChild(popup);
    popup.querySelector(".docura-popup-close").addEventListener("click", closePopup);
    setTimeout(() => document.addEventListener("click", onDocClickCloseP, true), 0);
  }

  function onDocClickCloseP(e) {
    const popup = document.querySelector(".docura-popup");
    if (popup && !popup.contains(e.target)) closePopup();
  }

  function closePopup() {
    document.querySelectorAll(".docura-popup").forEach((p) => p.remove());
    document.removeEventListener("click", onDocClickCloseP, true);
  }

  function computeListOverview() {
    if (!site.listMapping) return null;
    let rowsContainer;
    try {
      rowsContainer = document.querySelector(site.listMapping.rowsSelector);
    } catch {
      rowsContainer = null;
    }
    if (!rowsContainer) return null;

    const items = [];
    for (const row of rowsContainer.children) {
      if (row.tagName !== "TR") continue;
      const cell = row.children[site.listMapping.colIndex];
      const link = cell && cell.querySelector("a");
      if (!link || !link.href) continue;
      let pathname;
      try {
        pathname = new URL(link.href, location.href).pathname;
      } catch {
        continue;
      }
      items.push({ label: link.textContent.trim(), href: link.href, cached: site.claimCache[pathname] });
    }
    if (items.length === 0) return null;

    return {
      pending: items.filter((i) => i.cached && i.cached.outstanding.length > 0),
      clear: items.filter((i) => i.cached && i.cached.outstanding.length === 0),
      unknown: items.filter((i) => !i.cached),
    };
  }

  function overviewGroup(title, cls, list) {
    if (list.length === 0) return "";
    return `
      <div class="overview-group">
        <div class="overview-group-title ${cls}">${escapeHtml(title)} (${list.length})</div>
        <ul class="overview-list">
          ${list
            .map((i) => {
              const extra =
                i.cached && i.cached.outstanding.length
                  ? ` — ${escapeHtml(i.cached.outstanding[0])}${i.cached.outstanding.length > 1 ? ` (+${i.cached.outstanding.length - 1} more)` : ""}`
                  : "";
              return `<li><a class="overview-link" href="${i.href}">${escapeHtml(i.label)}</a>${extra}</li>`;
            })
            .join("")}
        </ul>
      </div>`;
  }

  function renderOnboarding() {
    const listDone = !!site.listMapping;
    const reqDone = !!site.requirementsTable;
    if (listDone && reqDone) return ""; // fully set up — nothing to show

    return `
      <section class="onboarding">
        <div class="onboarding-title">👋 Quick one-time setup (about a minute)</div>
        <p class="empty">You only need to show Docura Health these two things <b>once, ever</b>. After that, it automatically checks every claim for you — no more clicking required.</p>
        <div class="onboarding-step">
          <span class="step-num">${listDone ? "✅" : "1"}</span>
          <div class="step-body">
            <div class="step-title">Show us the main claims list</div>
            ${
              listDone
                ? `<div class="step-desc">Done.</div>`
                : `<div class="step-desc">Go to the main page that lists all your claims, then press the button below.</div>
                   <button class="link-btn" id="onboardListBtn">I'm on that page — start</button>`
            }
          </div>
        </div>
        <div class="onboarding-step">
          <span class="step-num">${reqDone ? "✅" : "2"}</span>
          <div class="step-body">
            <div class="step-title">Show us where the Requirements list is</div>
            ${
              reqDone
                ? `<div class="step-desc">Done.</div>`
                : `<div class="step-desc">Open any one claim on this site, click its "Requirements" tab so you can see that table, then press the button below.</div>
                   <button class="link-btn" id="onboardReqBtn">I'm on that page — start</button>`
            }
          </div>
        </div>
      </section>
    `;
  }

  function renderPanel() {
    const body = el("panelBody");
    const { found: reqFound, outstanding: reqOutstanding } = computeOutstandingForCurrentPage();
    const overview = computeListOverview();
    const setupDone = site.requirementsTable && site.listMapping;

    body.innerHTML = `
      ${renderOnboarding()}
      ${
        overview
          ? `<section>
               <div class="section-head"><h4>Claims overview</h4></div>
               ${overviewGroup("Pending", "ov-pending", overview.pending)}
               ${overviewGroup("Clear", "ov-clear", overview.clear)}
               ${overviewGroup("Not checked yet", "ov-unknown", overview.unknown)}
             </section>`
          : ""
      }
      ${
        setupDone
          ? `<section>
               <div class="section-head">
                 <h4>Claims list</h4>
                 <button class="link-btn" id="trackListBtn">Redo this</button>
               </div>
               <p class="empty">Already set up and working automatically. Only touch this again if Northstar's screen layout changes.</p>
             </section>
             <section>
               <div class="section-head">
                 <h4>Requirements tracking</h4>
                 <button class="link-btn" id="trackReqBtn">Redo this</button>
               </div>
               <p class="empty">${
                 reqFound
                   ? reqOutstanding.length === 0
                     ? "This claim's Requirements table is being tracked — nothing outstanding here right now."
                     : ""
                   : "Already set up and working automatically. Only touch this again if Northstar's screen layout changes."
               }</p>
               ${reqFound && reqOutstanding.length > 0 ? `<ul class="rule-list">${reqOutstanding.map((d) => `<li class="rule-fail"><span class="rule-icon">❌</span><span class="rule-desc">${escapeHtml(d)}</span></li>`).join("")}</ul>` : ""}
             </section>`
          : ""
      }
    `;

    const onboardReqBtn = el("onboardReqBtn");
    if (onboardReqBtn) onboardReqBtn.addEventListener("click", () => beginPick("reqStatus"));
    const onboardListBtn = el("onboardListBtn");
    if (onboardListBtn) onboardListBtn.addEventListener("click", () => beginPick("listLink"));
    const trackReqBtn = el("trackReqBtn");
    if (trackReqBtn) trackReqBtn.addEventListener("click", () => beginPick("reqStatus"));
    const trackListBtn = el("trackListBtn");
    if (trackListBtn) trackListBtn.addEventListener("click", () => beginPick("listLink"));
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Picker ----------

  const PICK_BANNERS = {
    reqStatus: 'Click one example <b>Activity Status</b> cell (e.g. "Open"). <b>Esc</b> to cancel.',
    reqDesc: 'Now click one example <b>Requirement</b> cell (e.g. "Obtain police incident report"). <b>Esc</b> to cancel.',
    listLink: 'Click one claim number link in the list (e.g. "NC-2025-1004"). <b>Esc</b> to cancel.',
    listStatus: 'Now click the <b>Current Status</b> cell for that same claim (e.g. "Open - Review"). <b>Esc</b> to cancel.',
  };

  function beginPick(kind) {
    pickKind = kind;
    el("pickBanner").innerHTML = PICK_BANNERS[kind];
    el("pickBanner").hidden = false;
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("click", onPick, true);
    document.addEventListener("keydown", onPickKeydown, true);
  }

  function endPick() {
    pickKind = null;
    pendingReqTable = null;
    pendingListMapping = null;
    el("pickBanner").hidden = true;
    document.removeEventListener("mouseover", onHover, true);
    document.removeEventListener("click", onPick, true);
    document.removeEventListener("keydown", onPickKeydown, true);
    document.querySelectorAll(".docura-hover-outline").forEach((n) => n.classList.remove("docura-hover-outline"));
  }

  function onPickKeydown(e) {
    if (e.key === "Escape") endPick();
  }

  function onHover(e) {
    if (host.contains(e.target)) return;
    document.querySelectorAll(".docura-hover-outline").forEach((n) => n.classList.remove("docura-hover-outline"));
    e.target.classList.add("docura-hover-outline");
  }

  async function onPick(e) {
    if (host.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const target = e.target;
    target.classList.remove("docura-hover-outline");

    if (pickKind === "reqStatus") {
      const cell = target.closest("td, th") || target;
      const row = cell.closest("tr");
      const table = cell.closest("table");
      if (!row || !table) return; // clicked outside any table — ignore, stay in picking mode
      pendingReqTable = {
        tableSelector: window.DocuraSelector.build(table).selectorPrimary,
        statusColIndex: Array.from(row.children).indexOf(cell),
      };
      pickKind = "reqDesc";
      el("pickBanner").innerHTML = PICK_BANNERS.reqDesc;
      return;
    }

    if (pickKind === "reqDesc") {
      const cell = target.closest("td, th") || target;
      const row = cell.closest("tr");
      if (!row || !pendingReqTable) return;
      site.requirementsTable = {
        ...pendingReqTable,
        descColIndex: Array.from(row.children).indexOf(cell),
      };
      await window.DocuraStorage.saveSite(hostname, site);
      endPick();
      refresh();
      return;
    }

    if (pickKind === "listLink") {
      const link = target.closest("a");
      if (!link) return; // ask them to click the actual link, stay in picking mode
      const cell = link.closest("td, th") || link.parentElement;
      const row = cell.closest("tr");
      if (!row || !row.parentElement) return;
      pendingListMapping = {
        rowsSelector: window.DocuraSelector.build(row.parentElement).selectorPrimary,
        colIndex: Array.from(row.children).indexOf(cell),
      };
      pickKind = "listStatus";
      el("pickBanner").innerHTML = PICK_BANNERS.listStatus;
      return;
    }

    if (pickKind === "listStatus") {
      const cell = target.closest("td, th") || target;
      const row = cell.closest("tr");
      if (!row || !pendingListMapping) return;
      site.listMapping = {
        ...pendingListMapping,
        statusColIndex: Array.from(row.children).indexOf(cell),
      };
      await window.DocuraStorage.saveSite(hostname, site);
      endPick();
      refresh();
      return;
    }
  }

  function STYLES() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, sans-serif; }
      #tab {
        position: fixed; top: 40%; right: 0; z-index: 2147483000;
        writing-mode: vertical-rl; transform: rotate(180deg);
        background: #1f2937; color: #fff; border: none; border-radius: 8px 0 0 8px;
        padding: 12px 6px; cursor: pointer; font-size: 12px; letter-spacing: 0.5px;
        display: flex; align-items: center; gap: 6px;
      }
      .badge {
        writing-mode: horizontal-tb; transform: rotate(-180deg);
        background: #dc2626; color: #fff; border-radius: 999px; font-size: 11px;
        min-width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; padding: 0 4px;
      }
      .panel {
        position: fixed; top: 0; right: 0; width: 360px; height: 100%; z-index: 2147483001;
        background: #fff; box-shadow: -4px 0 16px rgba(0,0,0,0.15); display: none; flex-direction: column;
      }
      .panel.open { display: flex; }
      .panel-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
      .panel-header .host { color: #6b7280; font-size: 12px; }
      .panel-header .spacer { flex: 1; }
      .panel-header button { background: none; border: none; cursor: pointer; font-size: 14px; padding: 4px; }
      .panel-body { flex: 1; overflow-y: auto; padding: 12px; }
      section { margin-bottom: 20px; }
      .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .section-head h4 { margin: 0; font-size: 13px; text-transform: uppercase; color: #374151; letter-spacing: 0.4px; }
      .link-btn { background: none; border: none; color: #2f6fed; cursor: pointer; font-size: 12px; }
      .link-btn:disabled { color: #9ca3af; cursor: not-allowed; }
      .empty { color: #6b7280; font-size: 12px; }
      .rule-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .rule-list li { display: flex; align-items: center; gap: 8px; border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 8px; font-size: 12px; }
      .rule-fail { background: #fef2f2; }
      .rule-desc { flex: 1; }
      .overview-group { margin-bottom: 12px; }
      .overview-group-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
      .ov-pending { color: #b91c1c; }
      .ov-clear { color: #15803d; }
      .ov-unknown { color: #6b7280; }
      .overview-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #374151; }
      .overview-link { color: #2f6fed; text-decoration: none; font-weight: 600; }
      .overview-link:hover { text-decoration: underline; }
      .onboarding { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px; }
      .onboarding-title { font-weight: 700; font-size: 14px; margin-bottom: 6px; }
      .onboarding-step { display: flex; gap: 10px; margin-top: 10px; }
      .step-num {
        flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: #2f6fed; color: #fff;
        display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
      }
      .step-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
      .step-desc { font-size: 12px; color: #4b5563; margin-bottom: 6px; }
      .pick-banner {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483002;
        background: #1f2937; color: #fff; padding: 8px 14px; border-radius: 6px; font-size: 13px;
      }
    `;
  }

  load();
  refreshTimer = setInterval(refresh, 8000);
})();
