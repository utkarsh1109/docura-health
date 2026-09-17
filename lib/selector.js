// Builds a best-effort CSS selector for a picked element. Because we have no
// visibility into Northstar's markup ahead of time, this favors stable
// attributes (id, data-testid, name, aria-label) and falls back to a short
// nth-of-type ancestor path.
(function () {
  function buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    for (const attr of ["data-testid", "data-qa", "name", "aria-label"]) {
      const val = el.getAttribute(attr);
      if (val) return `[${attr}="${CSS.escape(val)}"]`;
    }

    const path = [];
    let node = el;
    for (let i = 0; i < 5 && node && node.nodeType === 1 && node.tagName !== "BODY"; i++) {
      let piece = node.tagName.toLowerCase();
      if (node.classList.length) {
        piece += Array.from(node.classList)
          .slice(0, 2)
          .map((c) => "." + CSS.escape(c))
          .join("");
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) piece += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      path.unshift(piece);
      node = parent;
    }
    return path.join(" > ");
  }

  function textOf(el) {
    return (el && el.innerText ? el.innerText : "").trim();
  }

  function build(el) {
    return {
      selectorPrimary: buildSelector(el),
      anchorText: textOf(el).slice(0, 120),
    };
  }

  window.DocuraSelector = { build };
})();
