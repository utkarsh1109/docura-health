async function render() {
  const sites = await window.DocuraStorage.getAllSites();
  const container = document.getElementById("sites");
  const hostnames = Object.keys(sites);

  if (hostnames.length === 0) {
    container.innerHTML = `<div class="empty-state">No sites configured yet. Open the sidebar on a claims page and follow the one-time setup steps to get started.</div>`;
    return;
  }

  container.innerHTML = hostnames
    .map((host) => {
      const site = sites[host];
      const checkedCount = Object.keys(site.claimCache || {}).length;
      const pendingCount = Object.values(site.claimCache || {}).filter((c) => c.outstanding && c.outstanding.length > 0).length;
      return `
        <div class="site-card" data-host="${host}">
          <h2>${host}
            <button class="danger" data-delete-site="${host}" style="margin-left:auto">Delete site</button>
          </h2>
          <table>
            <thead><tr><th>Setup step</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td>Requirements table</td><td>${site.requirementsTable ? "✅ Set up" : "Not set up yet"}</td></tr>
              <tr><td>Claims list</td><td>${site.listMapping ? "✅ Set up" : "Not set up yet"}</td></tr>
              <tr><td>Claims checked so far</td><td>${checkedCount} (${pendingCount} with pending items)</td></tr>
            </tbody>
          </table>
          ${checkedCount > 0 ? `<button class="danger" data-clear-cache="${host}">Clear cached claim statuses</button>` : ""}
        </div>
      `;
    })
    .join("");

  container.querySelectorAll("[data-delete-site]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm(`Delete all setup for ${btn.dataset.deleteSite}?`)) return;
      await window.DocuraStorage.deleteSite(btn.dataset.deleteSite);
      render();
    })
  );

  container.querySelectorAll("[data-clear-cache]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const host = btn.dataset.clearCache;
      const site = await window.DocuraStorage.getSite(host);
      site.claimCache = {};
      await window.DocuraStorage.saveSite(host, site);
      render();
    })
  );
}

document.getElementById("exportBtn").addEventListener("click", async () => {
  const sites = await window.DocuraStorage.getAllSites();
  const blob = new Blob([JSON.stringify(sites, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "docura-health-config.json";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const imported = JSON.parse(text);
    const existing = await window.DocuraStorage.getAllSites();
    const merged = { ...existing, ...imported };
    for (const [host, data] of Object.entries(merged)) {
      await window.DocuraStorage.saveSite(host, data);
    }
    render();
  } catch (err) {
    alert("Could not import file: " + err.message);
  }
  e.target.value = "";
});

render();
