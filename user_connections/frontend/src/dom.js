// Tiny DOM helper: h('div', { class: 'x', onclick: fn }, 'text', childNode, ...)
// Text is always inserted as text (never HTML), so usernames can't inject markup.
function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

// Like el.replaceChildren(), but skips false/null (so `cond && h(...)` works) and flattens arrays.
export function setChildren(el, ...children) {
  if (!el) return;
  el.replaceChildren();
  append(el, children);
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === false || value == null) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

export const $ = (sel) => document.querySelector(sel);

export function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}
