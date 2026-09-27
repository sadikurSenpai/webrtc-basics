// "What's happening" panel: every step of the call, explained.
//
// log(category, title, { why, detail, trace })
//   category: which part of the system did it (colour + badge)
//   why:      one-line explanation for learners
//   detail:   raw data (SDP, candidate, JSON), shown when expanded
//   trace:    list of steps the SIGNAL SERVER reported doing
import { h, $ } from './dom.js';

export const CATEGORIES = {
  phase:        { label: 'STEP',        },
  api:          { label: 'BACKEND API', },
  'signal-out': { label: '→ SIGNAL',    },
  'signal-in':  { label: '← SIGNAL',    },
  media:        { label: 'MEDIA',       },
  sdp:          { label: 'SDP',         },
  ice:          { label: 'ICE',         },
  pc:           { label: 'PEER CONN',   },
  stats:        { label: 'STATS',       },
  error:        { label: 'ERROR',       },
};

const t0 = performance.now();
const hidden = new Set();

export function log(category, title, { why, detail, trace } = {}) {
  const list = $('#timeline-list');
  if (!list) return;
  const time = ((performance.now() - t0) / 1000).toFixed(1);

  if (category === 'phase') {
    list.append(h('div', { class: 'tl-phase', 'data-cat': category }, title));
    return scroll(list);
  }

  const entry = h('div', { class: `tl-entry cat-${category}`, 'data-cat': category },
    h('div', { class: 'tl-head' },
      h('span', { class: 'tl-time' }, `${time}s`),
      h('span', { class: 'tl-badge' }, CATEGORIES[category]?.label ?? category),
      h('span', { class: 'tl-title' }, title)),
    why && h('div', { class: 'tl-why' }, why),
    trace?.length && h('div', { class: 'tl-trace' },
      h('div', { class: 'tl-trace-title' }, '🖥 signal server did:'),
      h('ol', {}, trace.map((step) => h('li', {}, step)))),
    detail != null && h('details', {},
      h('summary', {}, 'show data'),
      h('pre', {}, typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2))),
  );
  if (hidden.has(category)) entry.hidden = true;
  list.append(entry);
  scroll(list);
}

function scroll(list) {
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 200) list.scrollTop = list.scrollHeight;
}

export const phase = (title) => log('phase', title);

// Filter chips + clear button.
export function mountTimelineControls(container) {
  container.append(
    ...Object.entries(CATEGORIES).filter(([k]) => k !== 'phase').map(([key, { label }]) =>
      h('button', {
        class: `chip cat-${key}`,
        title: 'Show / hide',
        onclick: (e) => {
          hidden.has(key) ? hidden.delete(key) : hidden.add(key);
          e.currentTarget.classList.toggle('off', hidden.has(key));
          document.querySelectorAll(`.tl-entry[data-cat="${key}"]`).forEach((el) => (el.hidden = hidden.has(key)));
        },
      }, label)),
    h('button', { class: 'chip', onclick: () => ($('#timeline-list').innerHTML = '') }, 'clear'),
    h('label', { class: 'chip' },
      h('input', { type: 'checkbox', checked: true,
        onchange: (e) => $('#timeline-list').classList.toggle('no-why', !e.target.checked) }),
      ' explanations'),
  );
}
