// App shell: login, friends, call screen, and wiring between
// the backend (REST), the signal server (WebSocket) and WebRTC (CallManager).
import './style.css';
import { $, h, setChildren, toast } from './dom.js';
import { api, session } from './api.js';
import { Signaling } from './signaling.js';
import { CallManager } from './call.js';
import { log, mountTimelineControls, phase } from './timeline.js';
import { describePath } from './stats.js';
import { renderRecordingsPage } from './recordings.js';

const onRecordingsPage = location.pathname.startsWith('/recordings');
const state = { me: null, friends: [], requests: [], history: [], signalStatus: 'offline' };
let signaling = null;
let calls = null;

// Created once and reused, so re-rendering never interrupts playback.
const localVideo = h('video', { autoplay: true, playsinline: true, muted: true, class: 'local' });
const remoteVideo = h('video', { autoplay: true, playsinline: true, class: 'remote' });

boot();

async function boot() {
  session.onUnauthorized = logout;
  if (session.token) {
    try {
      state.me = await api('/auth/me', { quiet: true });
      return enter(false);
    } catch {
      session.token = null;
    }
  }
  renderLogin();
}

// Same login for both pages; /recordings shows the admin page instead of the call app.
function enter(created) {
  if (onRecordingsPage) return renderRecordingsPage({ me: state.me, onLogout: logout });
  startApp(created);
}

// ================================================================== login

function renderLogin(error) {
  document.body.replaceChildren(
    h('div', { id: 'toasts' }),
    h('main', { class: 'login' },
      h('form', { class: 'card', onsubmit: onLogin },
        h('h1', {}, onRecordingsPage ? '🎞 Call recordings (admin)' : '📞 WebRTC 1-to-1 calls'),
        h('p', { class: 'muted' },
          'No sign-up needed: a new username is created with the password you type. ' +
          'Next time, log in with the same password.'),
        h('label', {}, 'Username',
          h('input', { name: 'username', required: true, minlength: 3, maxlength: 32,
            pattern: '[A-Za-z0-9_.]+', title: 'letters, numbers, _ and .', autocomplete: 'username' })),
        h('label', {}, 'Password',
          h('input', { name: 'password', type: 'password', required: true, minlength: 4, autocomplete: 'current-password' })),
        error && h('p', { class: 'error' }, error),
        h('button', { type: 'submit', class: 'primary' }, 'Log in'),
        h('p', { class: 'muted small' }, 'Note: calls in this demo app are recorded.'))));
}

async function onLogin(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const res = await api('/auth/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } });
    session.token = res.access_token;
    state.me = res.user;
    enter(res.created);
  } catch (e) {
    renderLogin(e.message);
  }
}

function logout() {
  calls?.hangup();
  signaling?.close();
  session.token = null;
  state.me = null;
  renderLogin();
}

// ==================================================================== app

async function startApp(created) {
  renderShell();
  phase(`👋 Logged in as ${state.me.username}`);
  log('api', created ? 'Backend created your account (password stored as an argon2 hash)' : 'Backend verified your password', {
    why: 'The backend returned a JWT (signed token). We send it on every REST call, and ONCE to the signal server to prove who we are.',
  });

  signaling = new Signaling({
    token: session.token,
    onMessage: (msg) => onSignal(msg).catch((e) => log('error', `${msg.type} handler failed: ${e.message}`)),
    onStatus: (status) => {
      state.signalStatus = status;
      renderHeader();
      renderFriends();
      if (status === 'online') refreshFriends();
    },
  });
  calls = new CallManager({
    signaling,
    getConfig: () => api('/config', { quiet: true }),
    onChange: renderStage,
    onStats: renderStats,
    onEnded: (text) => {
      toast(text);
      renderStats(null);
      setTimeout(refreshHistory, 500); // the server saves the final status to the DB
    },
  });
  signaling.connect();
  refreshFriends();
  refreshRequests();
  refreshHistory();
}

async function onSignal(msg) {
  switch (msg.type) {
    case 'call.incoming': return calls.onIncoming(msg);
    case 'call.ringing': return calls.onRinging(msg);
    case 'call.accepted': return calls.onAccepted(msg);
    case 'call.ended': return calls.onEndedMessage(msg);
    case 'webrtc.offer': return calls.onOffer(msg);
    case 'webrtc.answer': return calls.onAnswer(msg);
    case 'webrtc.candidate': return calls.onCandidate(msg);
    case 'media.state': return calls.onRemoteMediaState(msg);
    case 'error':
      toast(msg.message, 'error');
      return calls.onError(msg);
    case 'presence': {
      const friend = state.friends.find((f) => f.id === msg.user_id);
      if (friend) friend.online = msg.online;
      return renderFriends();
    }
    case 'friend.request':
      toast(`${msg.username} sent you a friend request`);
      return refreshRequests();
    case 'friend.accepted':
      toast(`${msg.username} accepted your friend request`);
      refreshRequests();
      return refreshFriends();
    case 'friend.declined':
      toast(`${msg.username} declined your friend request`);
      return refreshRequests();
    case 'friend.removed':
      toast(`${msg.username} removed you as a friend`);
      return refreshFriends();
    case 'session.replaced':
      return toast('You opened the app somewhere else; this tab is disconnected.', 'error');
  }
}

// ================================================================= layout

function renderShell() {
  document.body.replaceChildren(
    h('header', { id: 'header' }),
    h('main', { class: 'app' },
      h('aside', { class: 'sidebar' },
        h('section', { class: 'card' },
          h('h2', {}, 'Add a friend'),
          h('form', { class: 'row', onsubmit: onAddFriend },
            h('input', { name: 'username', placeholder: 'their username', required: true }),
            h('button', { type: 'submit' }, 'Send request'))),
        h('section', { class: 'card', id: 'requests' }),
        h('section', { class: 'card', id: 'friends' }),
        h('section', { class: 'card', id: 'history' })),
      h('section', { class: 'stage', id: 'stage' }),
      h('aside', { class: 'timeline card' },
        h('h2', {}, 'What\'s happening'),
        h('div', { class: 'chips', id: 'timeline-controls' }),
        h('div', { id: 'stats', hidden: true }),
        h('div', { id: 'timeline-list' }))),
    h('div', { id: 'modal-root' }),
    h('div', { id: 'toasts' }),
  );
  mountTimelineControls($('#timeline-controls'));
  renderHeader();
  renderStage();
}

function renderHeader() {
  const labels = { online: 'signal server: connected', connecting: 'signal server: connecting…', offline: 'signal server: offline' };
  setChildren($('#header'), h('strong', {}, '📞 WebRTC calls'),
    h('span', { class: `pill ${state.signalStatus}` }, labels[state.signalStatus]),
    h('span', { class: 'spacer' }),
    h('span', {}, 'Logged in as ', h('b', {}, state.me?.username)),
    h('button', { onclick: logout }, 'Log out'),
  );
}

// ================================================================ friends

async function refreshFriends() {
  try { state.friends = await api('/friends', { quiet: true }); } catch { /* shown via toast elsewhere */ }
  renderFriends();
}

async function refreshRequests() {
  try { state.requests = await api('/friends/requests', { quiet: true }); } catch {}
  renderRequests();
}

async function refreshHistory() {
  try { state.history = await api('/calls', { quiet: true }); } catch {}
  renderHistory();
}

async function onAddFriend(event) {
  event.preventDefault();
  const input = event.target.username;
  try {
    const res = await api('/friends/requests', { method: 'POST', body: { username: input.value } });
    toast(res.result === 'accepted' ? `You are now friends with ${input.value}` : `Request sent to ${input.value}`);
    input.value = '';
    refreshRequests();
    refreshFriends();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function respond(request, action) {
  try {
    await api(`/friends/requests/${request.id}/${action}`, { method: 'POST' });
    refreshRequests();
    refreshFriends();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function removeFriend(friend) {
  if (!confirm(`Remove ${friend.username} from your friends?`)) return;
  try {
    await api(`/friends/${friend.id}`, { method: 'DELETE' });
    refreshFriends();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderRequests() {
  const incoming = state.requests.filter((r) => r.direction === 'incoming');
  const outgoing = state.requests.filter((r) => r.direction === 'outgoing');
  setChildren($('#requests'), h('h2', {}, `Friend requests ${incoming.length ? `(${incoming.length})` : ''}`),
    !state.requests.length && h('p', { class: 'muted' }, 'None.'),
    incoming.map((r) => h('div', { class: 'item' },
      h('span', {}, h('b', {}, r.user.username), ' wants to be friends'),
      h('span', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => respond(r, 'accept') }, 'Accept'),
        h('button', { onclick: () => respond(r, 'decline') }, 'Decline')))),
    outgoing.map((r) => h('div', { class: 'item muted' }, `Waiting for ${r.user.username}…`)),
  );
}

function renderFriends() {
  const busy = calls && calls.state !== 'idle';
  const signalUp = state.signalStatus === 'online';
  setChildren($('#friends'), h('h2', {}, 'Friends'),
    !state.friends.length && h('p', { class: 'muted' }, 'No friends yet. Add someone by username.'),
    state.friends.map((f) => {
      const canCall = f.online && signalUp && !busy;
      const why = !signalUp ? 'Signal server not connected' : !f.online ? `${f.username} is offline` : busy ? 'Already in a call' : '';
      return h('div', { class: 'item' },
        h('span', {},
          h('span', { class: `dot ${f.online ? 'on' : f.online === false ? 'off' : 'unknown'}` }),
          f.username),
        h('span', { class: 'actions' },
          h('button', { title: why || 'Audio call', disabled: !canCall, onclick: () => calls.startCall(f, 'audio') }, '🎤'),
          h('button', { title: why || 'Video call', disabled: !canCall, onclick: () => calls.startCall(f, 'video') }, '🎥'),
          h('button', { title: 'Remove friend', class: 'ghost', onclick: () => removeFriend(f) }, '✕')));
    }),
  );
}

function renderHistory() {
  const icon = { ended: '✅', declined: '🚫', missed: '⏰', cancelled: '↩️', failed: '⚠️', ringing: '🔔', accepted: '🟢' };
  setChildren($('#history'), h('h2', {}, 'Recent calls'),
    !state.history.length && h('p', { class: 'muted' }, 'No calls yet.'),
    state.history.slice(0, 10).map((c) => {
      const secs = c.answered_at && c.ended_at ? Math.round((new Date(c.ended_at) - new Date(c.answered_at)) / 1000) : null;
      return h('div', { class: 'item small' },
        h('span', {}, `${c.direction === 'outgoing' ? '↗' : '↙'} ${c.other.username} · ${c.media}`),
        h('span', { class: 'muted', title: c.end_reason ?? '' },
          `${icon[c.status] ?? ''} ${c.status}${secs != null ? ` · ${formatDuration(secs)}` : ''} · ${timeAgo(c.created_at)}`));
    }),
  );
}

// ============================================================ call stage

let timerInterval = null;

function renderStage() {
  renderFriends(); // call buttons depend on call state
  const stage = $('#stage');
  if (!stage || !calls) return renderIdle(stage);
  const { state: callState, call } = calls;

  setChildren($('#modal-root'), callState === 'incoming' ? incomingModal(call) : '');
  document.title = callState === 'incoming' ? `📲 ${call.peer.username} is calling…` : 'WebRTC calls';
  clearInterval(timerInterval);

  if (callState === 'idle' || callState === 'incoming') return renderIdle(stage);

  setStream(localVideo, calls.localStream);
  setStream(remoteVideo, calls.remoteStream);
  const isVideo = call.media === 'video';
  const status = {
    outgoing: call.id ? `Ringing ${call.peer.username}…` : 'Getting camera/mic…',
    connecting: 'Connecting… (offer / answer / ICE)',
    active: '',
  }[callState];

  setChildren(stage, h('div', { class: `call ${isVideo ? 'video' : 'audio'}` },
      h('div', { class: 'remote-box' },
        remoteVideo,
        (!isVideo || callState !== 'active' || !calls.remoteMedia.video) &&
          h('div', { class: 'avatar' }, call.peer.username[0].toUpperCase()),
        h('div', { class: 'remote-label' },
          call.peer.username,
          !calls.remoteMedia.audio && h('span', { class: 'badge' }, '🔇 muted'),
          isVideo && !calls.remoteMedia.video && h('span', { class: 'badge' }, '📷 camera off'))),
      isVideo && h('div', { class: 'local-box' }, localVideo, !calls.cam && h('div', { class: 'local-off' }, 'camera off')),
      h('div', { class: 'status' }, status || h('span', { id: 'call-timer' }, '0:00')),
      h('div', { class: 'controls' },
        callState !== 'outgoing' && h('button', { class: calls.mic ? '' : 'off', onclick: () => calls.toggleMic() },
          calls.mic ? '🎤 Mute' : '🔇 Unmute'),
        callState !== 'outgoing' && isVideo && h('button', { class: calls.cam ? '' : 'off', onclick: () => calls.toggleCam() },
          calls.cam ? '📷 Camera off' : '📷 Camera on'),
        h('button', { class: 'danger', onclick: () => calls.hangup() }, callState === 'outgoing' ? 'Cancel' : 'Hang up'))),
  );
  if (!isVideo) remoteVideo.classList.add('hidden-media');
  else remoteVideo.classList.remove('hidden-media');

  if (callState === 'active') {
    const tick = () => {
      const el = $('#call-timer');
      if (el) el.textContent = formatDuration(Math.floor((Date.now() - calls.startedAt) / 1000));
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  }
}

function renderIdle(stage) {
  setChildren(stage, h('div', { class: 'card idle' },
      h('h2', {}, 'How a call works here'),
      h('ol', {},
        h('li', {}, h('b', {}, 'Backend'), ' (REST /api): login, friends, call history, STUN/TURN config.'),
        h('li', {}, h('b', {}, 'Signal server'), ' (WebSocket /ws): who is online, ringing, and relaying offer / answer / ICE candidates.'),
        h('li', {}, h('b', {}, 'WebRTC'), ': once connected, audio/video go ', h('i', {}, 'directly'), ' between the two browsers.')),
      h('p', {}, 'Pick an online friend (green dot) and press 🎤 or 🎥. Every step, from your browser AND from the signal server, appears in the panel on the right. Expand "show data" to see the real SDP and candidates.'),
      h('p', { class: 'muted' }, 'Tip: both of you watch your own panel; the caller and callee see different sides of the same flow.')),
  );
}

function incomingModal(call) {
  return h('div', { class: 'modal' },
    h('div', { class: 'card ringing' },
      h('div', { class: 'avatar big' }, call.peer.username[0].toUpperCase()),
      h('h2', {}, `${call.peer.username} is calling`),
      h('p', { class: 'muted' }, `${call.media === 'video' ? '🎥 Video' : '🎤 Audio'} call`),
      h('p', { class: 'small' }, 'Accept will: ① ask for your camera/mic → ② create an RTCPeerConnection → ③ tell the signal server → ④ wait for the caller\'s offer.'),
      h('div', { class: 'row center' },
        h('button', { class: 'primary', onclick: () => calls.accept() }, 'Accept'),
        h('button', { class: 'danger', onclick: () => calls.decline() }, 'Decline'))));
}

function renderStats(stats) {
  const box = $('#stats');
  if (!box) return;
  box.hidden = !stats;
  if (!stats) return;
  const fmt = (s) => s ? `${s.codec ?? '?'} · ${s.kbps ?? '…'} kbps${s.resolution ? ` · ${s.resolution}` : ''}${s.fps ? ` @${s.fps}fps` : ''}${s.packetsLost ? ` · lost ${s.packetsLost}` : ''}` : '—';
  const p = stats.path;
  box.replaceChildren(
    h('div', { class: 'stats-title' }, '📊 Live stats (pc.getStats, every 1s)'),
    h('table', {},
      h('tr', {}, h('td', {}, 'Path'), h('td', { title: describePath(p) }, p ? `${p.local} ⇄ ${p.remote} (${p.protocol})` : '…')),
      h('tr', {}, h('td', {}, 'Round trip'), h('td', {}, stats.rttMs != null ? `${stats.rttMs} ms` : '…')),
      h('tr', {}, h('td', {}, 'Send audio'), h('td', {}, fmt(stats.send.audio))),
      stats.send.video && h('tr', {}, h('td', {}, 'Send video'), h('td', {}, fmt(stats.send.video))),
      h('tr', {}, h('td', {}, 'Recv audio'), h('td', {}, fmt(stats.recv.audio))),
      stats.recv.video && h('tr', {}, h('td', {}, 'Recv video'), h('td', {}, fmt(stats.recv.video)))),
  );
}

// ================================================================ helpers

function setStream(video, stream) {
  if (video.srcObject === stream) return;
  video.srcObject = stream ?? null;
  if (!stream) return;
  // Browsers block autoplay WITH SOUND until the user has interacted with the page.
  video.play().catch(() => {
    toast('Click anywhere to start the remote audio/video');
    document.addEventListener('click', () => video.play().catch(() => {}), { once: true });
  });
}

function formatDuration(secs) {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
