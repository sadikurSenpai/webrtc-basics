// Admin page (/recordings): every recorded call, one row per call.
// Opening a call shows both sides next to each other. Each side's file has
// that person's video + BOTH voices, so audio plays from one file only.
import { $, h, setChildren, toast } from './dom.js';
import { api } from './api.js';

export async function renderRecordingsPage({ me, onLogout }) {
  document.body.replaceChildren(
    h('header', {},
      h('strong', {}, '🎞 Call recordings'),
      h('a', { href: '/' }, '← back to calls'),
      h('span', { class: 'spacer' }),
      h('span', {}, 'Logged in as ', h('b', {}, me.username)),
      h('button', { onclick: onLogout }, 'Log out')),
    h('main', { class: 'recordings' },
      h('section', { class: 'card', id: 'rec-list' }, h('p', { class: 'muted' }, 'Loading…')),
      h('section', { class: 'card', id: 'rec-player' },
        h('p', { class: 'muted' }, 'Pick a call to watch both sides.'))),
    h('div', { id: 'toasts' }),
  );

  if (!me.is_admin) {
    setChildren($('#rec-list'), h('h2', {}, 'Admins only'),
      h('p', {}, 'Ask the owner to run: ', h('code', {}, `uv run python -m app.cli make-admin ${me.username}`)));
    return;
  }

  try {
    renderList(await api('/admin/recordings'));
  } catch (e) {
    setChildren($('#rec-list'), h('p', { class: 'error' }, e.message));
  }
}

const STATUS_ICON = { complete: '✅', partial: '⚠️', failed: '❌', recording: '⏺' };

function renderList(rows) {
  setChildren($('#rec-list'),
    h('h2', {}, `Recorded calls (${rows.length})`),
    !rows.length && h('p', { class: 'muted' }, 'No recordings yet. Make a call first.'),
    rows.length > 0 && h('table', { class: 'rec-table' },
      h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Call'), h('th', {}, 'Length'), h('th', {}, 'Recordings')),
      rows.map((row) => h('tr', { class: 'clickable', onclick: (e) => openCall(row, e.currentTarget) },
        h('td', {}, new Date(row.created_at).toLocaleString()),
        h('td', {}, `${row.caller.username} → ${row.callee.username}`, h('div', { class: 'muted small' }, `${row.media} · ${row.call_status}`)),
        h('td', {}, row.answered_at && row.ended_at ? duration((new Date(row.ended_at) - new Date(row.answered_at)) / 1000) : '—'),
        h('td', {}, row.sides.map((s) => h('div', { class: 'small' },
          `${STATUS_ICON[s.status] ?? ''} ${s.username} · ${s.chunk_count} chunks · ${mb(s.size_bytes)}`)))))),
  );
}

async function openCall(row, tr) {
  document.querySelectorAll('.rec-table tr.selected').forEach((el) => el.classList.remove('selected'));
  tr.classList.add('selected');
  const player = $('#rec-player');
  setChildren(player, h('p', { class: 'muted' }, 'Loading…'));

  let sides;
  try {
    sides = await api(`/admin/calls/${row.call_id}/recordings`);
  } catch (e) {
    return setChildren(player, h('p', { class: 'error' }, e.message));
  }
  if (!sides.length) return setChildren(player, h('p', { class: 'muted' }, 'No recordings for this call.'));

  const t0 = Math.min(...sides.map((s) => new Date(s.started_at).getTime()));
  const views = sides.map((side) => ({
    side,
    offsetMs: new Date(side.started_at).getTime() - t0, // how much later this side started recording
    video: h('video', { controls: true, playsinline: true, preload: 'auto' }),
    status: h('div', { class: 'muted small' }, `Downloading 0/${side.chunk_urls.length} chunks…`),
    download: h('a', { class: 'small', hidden: true }, '⬇ download'),
  }));
  // Every file contains both voices: play audio from the first one only.
  views.forEach((v, i) => (v.video.muted = i !== 0));

  setChildren(player,
    h('h2', {}, `${row.caller.username} → ${row.callee.username} · ${new Date(row.created_at).toLocaleString()}`),
    h('div', { class: 'row sync-controls' },
      h('button', { class: 'primary', onclick: () => playTogether(views) }, '▶ Play both from start'),
      h('button', { onclick: () => views.forEach((v) => v.video.pause()) }, '⏸ Pause both'),
      h('span', { class: 'muted small' }, 'Audio from: '),
      views.map((v, i) => h('label', { class: 'small' },
        h('input', { type: 'radio', name: 'audio-src', checked: i === 0,
          onchange: () => views.forEach((o, j) => (o.video.muted = j !== i)) }),
        ` ${v.side.user.username}'s file `))),
    h('div', { class: 'rec-sides' },
      views.map((v) => h('div', { class: 'rec-side' },
        h('h3', {}, `${v.side.user.username} (${v.side.role}) ${STATUS_ICON[v.side.status] ?? ''} ${v.side.status}`),
        v.video,
        v.status,
        v.download))),
    h('p', { class: 'muted small' },
      'Each file = that person\'s camera + both voices mixed. Each side started recording when its own connection came up, ' +
      '"Play both" starts the later one after that offset so they line up.'),
  );

  await Promise.all(views.map(loadSide));
}

// Downloads every chunk and joins them. MediaRecorder chunks are pieces of ONE
// continuous file, so concatenating them in order gives a playable file.
async function loadSide(view) {
  const { side } = view;
  if (!side.chunk_urls.length) {
    view.status.textContent = 'No chunks were uploaded.';
    return;
  }
  const parts = new Array(side.chunk_urls.length);
  let done = 0;
  try {
    await mapLimit(side.chunk_urls, 6, async (url, i) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`chunk ${i}: HTTP ${res.status}`);
      parts[i] = await res.blob();
      view.status.textContent = `Downloading ${++done}/${side.chunk_urls.length} chunks…`;
    });
  } catch (e) {
    view.status.textContent = `Download failed: ${e.message}`;
    return toast(e.message, 'error');
  }
  const file = new Blob(parts, { type: side.mime_type });
  const url = URL.createObjectURL(file);
  view.video.src = url;
  fixWebmDuration(view.video);
  view.status.textContent = `${side.chunk_urls.length} chunks · ${mb(file.size)}${side.duration_seconds ? ` · ${duration(side.duration_seconds)}` : ''}`;
  Object.assign(view.download, { href: url, download: `${side.user.username}-${side.recording_id}${side.mime_type.includes('mp4') ? '.mp4' : '.webm'}`, hidden: false });
}

function playTogether(views) {
  for (const v of views) {
    v.video.pause();
    v.video.currentTime = 0;
    setTimeout(() => v.video.play().catch(() => {}), v.offsetMs);
  }
}

// Files from MediaRecorder don't store their total duration, so the seek bar
// shows nothing. Seeking far past the end makes the browser compute it.
function fixWebmDuration(video) {
  video.addEventListener('loadedmetadata', function onMeta() {
    video.removeEventListener('loadedmetadata', onMeta);
    if (video.duration !== Infinity) return;
    video.currentTime = 1e101;
    video.addEventListener('timeupdate', function onUpdate() {
      video.removeEventListener('timeupdate', onUpdate);
      video.currentTime = 0;
    });
  });
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const duration = (secs) => `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;
