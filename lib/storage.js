// Shared storage helpers. Config is keyed by hostname so the same install
// can hold separate field maps for Northstar prod, a staging environment,
// or any other claims portal, without them colliding.
(function () {
  const ROOT_KEY = "docura:sites";

  async function getAllSites() {
    const data = await chrome.storage.local.get(ROOT_KEY);
    return data[ROOT_KEY] || {};
  }

  async function getSite(hostname) {
    const sites = await getAllSites();
    return (
      sites[hostname] || {
        fields: [],
        rules: [],
      }
    );
  }

  async function saveSite(hostname, siteData) {
    const sites = await getAllSites();
    sites[hostname] = siteData;
    await chrome.storage.local.set({ [ROOT_KEY]: sites });
  }

  async function deleteSite(hostname) {
    const sites = await getAllSites();
    delete sites[hostname];
    await chrome.storage.local.set({ [ROOT_KEY]: sites });
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  window.DocuraStorage = { getAllSites, getSite, saveSite, deleteSite, uid };
})();
