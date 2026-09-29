/**
 * The only way this client builds DOM. User-supplied text is always set with
 * textContent / createTextNode, never parsed as HTML, so names and chat can't
 * inject markup or scripts. (There is no innerHTML anywhere in the client; a
 * test enforces that.)
 */

const SAFE_ATTRIBUTES = new Set([
    "id", "type", "role", "title", "for", "name", "value", "min", "max", "step",
    "maxlength", "placeholder", "aria-label", "aria-selected", "aria-pressed", "tabindex",
]);

/**
 * el("button", { class: "x", text: userName, onclick: fn }, child, "text")
 */
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = String(value);
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
        else if (key === "checked" || key === "disabled" || key === "selected" || key === "hidden") node[key] = Boolean(value);
        else if (SAFE_ATTRIBUTES.has(key)) node.setAttribute(key, value === true ? "" : String(value));
        else throw new Error(`el(): attribute "${key}" is not allowed`);
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    }
    return node;
}

export function $(id) {
    return document.getElementById(id);
}

export function setText(node, text) {
    node.textContent = text == null ? "" : String(text);
}

export function show(node, visible = true) {
    node.hidden = !visible;
}
