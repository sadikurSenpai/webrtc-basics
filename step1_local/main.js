// =====================================================================
// STEP 1 — Two WebRTC peers in ONE page, with NO server.
//
// Peer A = caller, Peer B = callee. Each one has its own RTCPeerConnection,
// just like two phones would. The difference from a real app:
//
//   * Both peers live in this one browser tab.
//   * The "signaling server" is the `signal()` function below. It passes a
//     JS object from one peer to the other. In Step 3 we replace it with a
//     real Python WebSocket server, and the rest of this code barely changes.
//   * No STUN/TURN servers: on one machine the peers can reach each other
//     through local ("host") addresses. (Step 5 covers STUN/TURN.)
//
// Open DevTools → Console to see the full SDP text as well.
// =====================================================================

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Logging helper: prints to the on-page log and to the console.
// who = 'A' | 'B' | 'SIG' (signaling) | 'SYS' (system messages)
// ---------------------------------------------------------------------
const t0 = performance.now();
function log(who, msg, kind = '') {
  const t = ((performance.now() - t0) / 1000).toFixed(2).padStart(7);
  const line = document.createElement('div');
  line.className = `line ${who} ${kind}`;
  line.textContent = `[${t}s] ${who.padEnd(3)} │ ${msg}`;
  $('log').appendChild(line);
  $('log').scrollTop = $('log').scrollHeight;
  console.log(`[${who}] ${msg}`);
}

// ---------------------------------------------------------------------
// Per-peer state. In a real app, each phone holds only ITS OWN half of this.
// ---------------------------------------------------------------------
const peers = {
  A: { pc: null, stream: null, inbox: null, pendingCandidates: [] },
  B: { pc: null, stream: null, inbox: null, pendingCandidates: [] },
};
const otherOf = (name) => (name === 'A' ? 'B' : 'A');

// =====================================================================
// FAKE SIGNALING
// Real app: phone → WebSocket → your backend → WebSocket → other phone.
// Here: a function call with a small delay to simulate network latency.
// Note that WebRTC never calls this for you. It only hands you the
// data (SDP, ICE candidates) and YOU decide how to deliver it.
// =====================================================================
function signal(from, to, message) {
  log('SIG', `${from} ──► ${to}   { type: "${message.type}" }`);
  setTimeout(() => onSignalMessage(to, message), 50);
}

// What a peer does when a signaling message arrives.
// In Step 3 this becomes the WebSocket `onmessage` handler.
async function onSignalMessage(name, message) {
  const p = peers[name];
  if (!p.pc) return; // this peer already hung up

  switch (message.type) {
    case 'offer':
    case 'answer':
      // Normally you'd apply it right away. We park it in an "inbox" so
      // you can apply it yourself with the next button and see each step.
      p.inbox = message;
      log(name, `📥 ${message.type} arrived. Click the next step to apply it.`);
      break;

    case 'candidate':
      // A candidate can arrive BEFORE we've applied the remote description
      // (ICE starts as soon as the other side calls setLocalDescription).
      // addIceCandidate() would throw then, so we queue it. Real apps hit
      // this race condition too, and handle it the same way.
      if (p.pc.remoteDescription) {
        await p.pc.addIceCandidate(message.candidate);
        log(name, `✅ addIceCandidate(${shortCandidate(message.candidate.candidate)})`);
      } else {
        p.pendingCandidates.push(message.candidate);
        log(name, `⏳ candidate queued (no remote description yet): ${p.pendingCandidates.length} waiting`);
      }
      break;

    case 'hangup':
      log(name, '📴 Other side said "hangup" via signaling. Closing right away.', 'ok');
      closePeer(name);
      break;
  }
}

// Apply queued candidates once the remote description is set.
async function flushPendingCandidates(name) {
  const p = peers[name];
  for (const c of p.pendingCandidates) {
    await p.pc.addIceCandidate(c);
    log(name, `✅ addIceCandidate(${shortCandidate(c.candidate)}) [from queue]`);
  }
  p.pendingCandidates = [];
}

// =====================================================================
// STEP 1: Get media (camera + mic, or a fake stream)
// =====================================================================
async function step1_getMedia() {
  if ($('fakeMedia').checked) {
    // Fake streams, so you don't need a camera/mic and can tell A and B apart.
    peers.A.stream = makeFakeStream('A', '#2563eb', 440);
    peers.B.stream = makeFakeStream('B', '#c2410c', 660);
    log('SYS', 'Using fake media: animated canvas (video) + quiet tone (audio). Unmute remote videos to hear it.');
  } else {
    // A real app does exactly this. On mobile it triggers the OS permission prompt.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    // One camera on this machine, so both peers share the same stream.
    peers.A.stream = stream;
    peers.B.stream = stream;
  }
  $('localA').srcObject = peers.A.stream;
  $('localB').srcObject = peers.B.stream;

  for (const name of ['A', 'B']) {
    for (const track of peers[name].stream.getTracks()) {
      log(name, `🎤 got local ${track.kind} track: "${track.label}"`);
    }
  }
}

// =====================================================================
// STEP 2: Create one RTCPeerConnection per peer and wire up events
// =====================================================================
function step2_createPeers() {
  peers.A.pc = createPeer('A');
  peers.B.pc = createPeer('B');
}

function createPeer(name) {
  const other = otherOf(name);

  // iceServers is empty. With no STUN, only local addresses are found.
  // Real app: [{ urls: 'stun:...' }, { urls: 'turn:...', username, credential }]
  const pc = new RTCPeerConnection({ iceServers: [] });
  log(name, '🆕 new RTCPeerConnection({ iceServers: [] })');

  // --- ICE: the browser found a network address we could be reached at.
  //     We must deliver it to the other peer ourselves (via signaling).
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      log(name, `🧊 found ICE candidate: ${shortCandidate(event.candidate.candidate)}`);
      signal(name, other, { type: 'candidate', candidate: event.candidate.toJSON() });
    } else {
      log(name, '🧊 ICE gathering finished (null candidate)');
    }
  };

  // --- Remote media arrived from the other peer.
  pc.ontrack = (event) => {
    log(name, `🎬 ontrack: receiving ${event.track.kind} from ${other}`, 'ok');
    $('remote' + name).srcObject = event.streams[0];
  };

  // --- State machines worth watching. Read these logs carefully.
  pc.onsignalingstatechange = () =>
    log(name, `📜 signalingState     → ${pc.signalingState}`);
  pc.onicegatheringstatechange = () =>
    log(name, `📡 iceGatheringState  → ${pc.iceGatheringState}`);
  pc.oniceconnectionstatechange = () =>
    log(name, `🔌 iceConnectionState → ${pc.iceConnectionState}`);
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    log(name, `🌐 connectionState    → ${s}`, s === 'connected' ? 'ok' : s === 'failed' ? 'err' : '');
    if (s === 'connected') {
      logSelectedPath(name);
      $('hangup').disabled = false;
      $('hangupSilent').disabled = false;
    }
  };

  // --- Attach our media. This must happen BEFORE createOffer/createAnswer,
  //     so the SDP says "I will send audio + video".
  for (const track of peers[name].stream.getTracks()) {
    pc.addTrack(track, peers[name].stream);
    log(name, `➕ addTrack(${track.kind})`);
  }
  return pc;
}

// =====================================================================
// STEP 3: A creates the OFFER and sends it
// =====================================================================
async function step3_createOffer() {
  const pc = peers.A.pc;

  // 1) Ask the browser: "describe what I can send and receive" → SDP text.
  const offer = await pc.createOffer();
  log('A', `📝 createOffer() → SDP (${offer.sdp.split('\r\n').length} lines)`);
  logSdpSummary('A', offer.sdp);

  // 2) Commit to it. This is also what STARTS ICE gathering, so candidate
  //    logs will show up right after this line.
  await pc.setLocalDescription(offer);
  log('A', '✔ setLocalDescription(offer)');

  // 3) Deliver it to B via signaling.
  signal('A', 'B', { type: 'offer', sdp: offer.sdp });
}

// =====================================================================
// STEP 4: B applies the offer it received
// =====================================================================
async function step4_applyOffer() {
  const p = peers.B;
  if (!p.inbox || p.inbox.type !== 'offer') throw new Error('B has no offer in its inbox yet');
  await p.pc.setRemoteDescription(p.inbox);
  log('B', "✔ setRemoteDescription(offer): B now knows what A wants to send");
  p.inbox = null;
  await flushPendingCandidates('B');
}

// =====================================================================
// STEP 5: B creates the ANSWER and sends it back
// =====================================================================
async function step5_createAnswer() {
  const pc = peers.B.pc;
  const answer = await pc.createAnswer(); // picks codecs compatible with A's offer
  log('B', `📝 createAnswer() → SDP (${answer.sdp.split('\r\n').length} lines)`);
  logSdpSummary('B', answer.sdp);
  await pc.setLocalDescription(answer); // B starts gathering ICE candidates now
  log('B', '✔ setLocalDescription(answer)');
  signal('B', 'A', { type: 'answer', sdp: answer.sdp });
}

// =====================================================================
// STEP 6: A applies the answer. Negotiation done, ICE connects.
// =====================================================================
async function step6_applyAnswer() {
  const p = peers.A;
  if (!p.inbox || p.inbox.type !== 'answer') throw new Error('A has no answer in its inbox yet');
  await p.pc.setRemoteDescription(p.inbox);
  log('A', '✔ setRemoteDescription(answer): offer/answer complete, watch ICE connect');
  p.inbox = null;
  await flushPendingCandidates('A');
}

// =====================================================================
// HANG UP
// =====================================================================
// The proper way: tell the other side through signaling, then close.
function hangUp() {
  log('SYS', '── Hang up (with signaling) ──');
  signal('A', 'B', { type: 'hangup' });
  closePeer('A');
}

// The "crash" way: A just disappears. B is never told. Watch how long
// B's connectionState takes to notice, and that it can't tell WHY.
function hangUpSilently() {
  log('SYS', '── A closes silently. B is NOT told. Watch B\'s states over the next seconds ──');
  closePeer('A');
}

function closePeer(name) {
  const p = peers[name];
  if (!p.pc) return;
  p.pc.close(); // note: close() does NOT fire this peer's own state events
  p.pc = null;
  $('remote' + name).srcObject = null;
  log(name, '🔌 pc.close(). This peer has left the call.');
  $('hangup').disabled = true;
  $('hangupSilent').disabled = true;
}

// =====================================================================
// Helpers
// =====================================================================

// "candidate:842163049 1 udp 1677729535 192.168.1.5 54321 typ host ..."
//  → "udp 192.168.1.5:54321 typ host"
function shortCandidate(c) {
  const f = c.split(' ');
  return `${f[2]} ${f[4]}:${f[5]} typ ${f[7]}`;
}

// Print the most interesting SDP lines (full text goes to the console).
// Step 2 of the course reads SDP line by line.
function logSdpSummary(name, sdp) {
  console.log(`----- ${name} full SDP -----\n${sdp}`);
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('m=')) log(name, `     SDP ${line}   ← a media section`, 'sdp');
    else if (/^a=rtpmap:\d+ (opus|VP8|H264)\//.test(line)) log(name, `     SDP ${line}   ← a codec`, 'sdp');
    else if (line.startsWith('a=fingerprint')) log(name, `     SDP ${line.slice(0, 50)}…   ← DTLS encryption key fingerprint`, 'sdp');
  }
}

// After connecting: which network path did ICE actually choose?
async function logSelectedPath(name) {
  const pc = peers[name].pc;
  if (!pc) return;
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); // Chrome
  });
  if (!pair) stats.forEach((r) => {
    if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r; // Firefox
  });
  if (!pair) return log(name, 'could not find the selected candidate pair');
  const l = stats.get(pair.localCandidateId);
  const r = stats.get(pair.remoteCandidateId);
  const addr = (c) => `${c.address ?? c.ip}:${c.port}`;
  log(name, `🔗 chosen path: ${addr(l)} (${l.candidateType}) ⇄ ${addr(r)} (${r.candidateType}) over ${l.protocol}`, 'ok');
}

// Canvas animation + oscillator tone → a MediaStream, like a fake camera and mic.
let audioCtx = null;
function makeFakeStream(label, color, freq) {
  const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
  const ctx = canvas.getContext('2d');
  (function draw() {
    const t = performance.now() / 1000;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText(`Peer ${label}`, 90, 110);
    ctx.font = '18px monospace';
    ctx.fillText(new Date().toLocaleTimeString(), 105, 145);
    ctx.beginPath();
    ctx.arc(160 + Math.sin(t * 2) * 120, 200, 12, 0, Math.PI * 2);
    ctx.fill();
    requestAnimationFrame(draw);
  })();

  audioCtx ??= new AudioContext();
  const osc = audioCtx.createOscillator();
  osc.frequency.value = freq;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.03; // quiet
  const dest = audioCtx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();

  return new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
}

// =====================================================================
// Button wiring: steps must run in order, and the next one is highlighted.
// =====================================================================
const steps = [step1_getMedia, step2_createPeers, step3_createOffer,
               step4_applyOffer, step5_createAnswer, step6_applyAnswer];
const stepButtons = [...document.querySelectorAll('#steps button[data-step]')];
let current = 0;

function refreshButtons() {
  stepButtons.forEach((b, i) => {
    b.disabled = i !== current;
    b.classList.toggle('next', i === current);
  });
  $('autoRun').disabled = current !== 0;
  $('fakeMedia').disabled = current !== 0;
}

async function runStep(i) {
  log('SYS', `──────── ${stepButtons[i].textContent} ────────`);
  try {
    await steps[i]();
    current = i + 1;
  } catch (err) {
    log('SYS', `❌ ${err.name}: ${err.message}`, 'err');
  }
  refreshButtons();
}

stepButtons.forEach((b, i) => b.addEventListener('click', () => runStep(i)));

$('autoRun').addEventListener('click', async () => {
  for (let i = 0; i < steps.length; i++) {
    await runStep(i);
    if (current !== i + 1) return; // stop on error
    await new Promise((r) => setTimeout(r, 300)); // let signaling messages arrive
  }
});

$('hangup').addEventListener('click', hangUp);
$('hangupSilent').addEventListener('click', hangUpSilently);
$('reset').addEventListener('click', () => location.reload());

refreshButtons();
log('SYS', 'Ready. Click the green button to go step by step, or Auto-run.');
