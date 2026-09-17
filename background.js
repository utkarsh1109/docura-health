// Injects the sidebar on demand when the toolbar icon is clicked.
// No host_permissions/content_scripts are declared in the manifest, so this
// extension works on whatever claims portal tab is active (Northstar or
// otherwise) without us needing to know its domain ahead of time.

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "docura:openOptions") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    const [{ result: alreadyInjected } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__docuraHealthInjected,
    });

    if (alreadyInjected) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.dispatchEvent(new CustomEvent("docura:toggle")),
      });
      return;
    }
  } catch (err) {
    // executeScript throws on restricted pages (chrome://, the Web Store,
    // PDF viewer, etc). Nothing we can do there — just stop quietly.
    console.warn("Docura Health: cannot inject into this page.", err);
    return;
  }

  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["content/sidebar.css"],
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["lib/storage.js", "lib/selector.js", "content/sidebar.js"],
  });
});
