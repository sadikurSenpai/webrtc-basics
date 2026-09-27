// =====================================================================
// STEP 2 — Reading SDP and ICE candidates.
//
// We negotiate between two local RTCPeerConnections (like Step 1), but:
//   * no camera: addTransceiver('audio'/'video') is enough to get SDP
//   * we WAIT for ICE gathering to finish, so pc.localDescription contains
//     every candidate, and then we explain each SDP line.
// =====================================================================

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// What each codec name means.
// ---------------------------------------------------------------------
const CODECS = {
  opus: 'Opus: THE WebRTC voice codec (adaptive, 6–510 kbps)',
  red: 'RED: redundant encoding (sends older packets again inside new ones)',
  G722: 'G.722: old wideband phone codec',
  PCMU: 'G.711 µ-law: classic telephone codec (64 kbps)',
  PCMA: 'G.711 A-law: classic telephone codec (64 kbps)',
  CN: 'Comfort Noise: fake background noise during silence',
  'telephone-event': 'DTMF: keypad tones (press 1 for...)',
  ILBC: 'iLBC: old low-bitrate voice codec',
  ISAC: 'iSAC: old Google voice codec',
  VP8: 'VP8: video codec every WebRTC implementation must support',
  VP9: 'VP9: better compression than VP8, more CPU',
  H264: 'H.264: video codec with hardware support on most phones',
  AV1: 'AV1: newest, best compression, heavy on CPU',
  H265: 'H.265/HEVC: hardware-friendly, licensing-heavy',
  rtx: 'RTX: retransmission stream (lost packets are re-sent on this)',
  ulpfec: 'ULPFEC: forward error correction (recover losses without resending)',
  flexfec: 'FlexFEC: forward error correction',
};

// ---------------------------------------------------------------------
// Line explanations: [regex, explanation (string or fn(match)), isKey]
// "isKey" lines are highlighted as the ones you really need to know.
// ---------------------------------------------------------------------
const RULES = [
  // ---- session level ----
  [/^v=0/, 'Protocol version. Always 0.'],
  [/^o=(\S+) (\d+) (\d+)/, (m) =>
    `Origin. Session id ${m[2].slice(0, 6)}… stays fixed for the call; version ${m[3]} goes up every time this side renegotiates (e.g. ICE restart).`],
  [/^s=/, 'Session name. Unused by WebRTC ("-").'],
  [/^t=0 0/, 'Timing: 0 0 = "permanent session". Always this in WebRTC.'],
  [/^a=group:BUNDLE (.*)/, (m) =>
    `BUNDLE: all media sections (mids ${m[1]}) share ONE network connection, so one ICE negotiation for audio + video + data.`, true],
  [/^a=extmap-allow-mixed/, 'Allows mixing 1-byte and 2-byte RTP header extensions. Low-level detail.'],
  [/^a=msid-semantic/, 'Declares that "a=msid" lines identify MediaStreams. Low-level detail.'],
  [/^a=ice-lite/, 'ICE-lite: this side is a server (e.g. an SFU) that only answers connectivity checks.', true],

  // ---- media section start ----
  [/^m=application (\d+) (\S+) (.*)/, (m) =>
    `START of the DATA CHANNEL section. Uses SCTP over DTLS (${m[2]}), for chat, signaling, file transfer peer-to-peer. Port ${m[1]} is a placeholder.`, true],
  [/^m=(audio|video) (\d+) (\S+) (.*)/, (m) =>
    `START of a ${m[1].toUpperCase()} section. Port ${m[2]} is a placeholder (ICE picks the real ports). ` +
    `${m[3]} = RTP media, encrypted with DTLS-SRTP, with feedback. ` +
    `Numbers = payload types, in order of preference: ${m[4].split(' ').length} formats.`, true],
  [/^c=IN IP4 0\.0\.0\.0/, 'Connection address placeholder. Real addresses come from ICE candidates.'],
  [/^c=/, 'Connection address (legacy; ICE decides the real one).'],
  [/^a=rtcp:/, 'Legacy RTCP port placeholder (rtcp-mux makes it irrelevant).'],

  // ---- ICE ----
  [/^a=ice-ufrag:(.*)/, (m) =>
    `ICE username fragment "${m[1]}". Used in the connectivity checks so only the peer that got this SDP can answer them. Changes on ICE restart.`, true],
  [/^a=ice-pwd:/, 'ICE password, paired with ice-ufrag. This is why signaling must be private (wss://).', true],
  [/^a=ice-options:trickle/, 'Trickle ICE: candidates are sent one by one as they are found (our onicecandidate → signaling), so we don\'t wait for all of them.', true],
  [/^a=candidate:/, 'An ICE candidate embedded in the SDP (see the candidate table below).'],
  [/^a=end-of-candidates/, 'No more candidates will follow.'],

  // ---- DTLS / security ----
  [/^a=fingerprint:(\S+)/, (m) =>
    `${m[1]} hash of this peer's DTLS certificate. The encryption handshake checks the other side's certificate against this. ` +
    `If an attacker could change it in signaling, they could intercept the call, so signaling needs TLS + auth.`, true],
  [/^a=setup:actpass/, 'DTLS role: "actpass" = offerer says "I can be client or server, you choose".', true],
  [/^a=setup:active/, 'DTLS role: "active" = this side starts the DTLS handshake (client).', true],
  [/^a=setup:passive/, 'DTLS role: "passive" = this side waits for the handshake (server).', true],

  // ---- media section details ----
  [/^a=mid:(.*)/, (m) => `Media ID "${m[1]}". Matches an entry in a=group:BUNDLE.`, true],
  [/^a=extmap:(\d+)\S* (\S+)/, (m) =>
    `RTP header extension #${m[1]}: ${m[2].split('/').pop().replace(/.*#/, '')}. Extra metadata on each packet (audio level, timing, orientation…).`],
  [/^a=(sendrecv|sendonly|recvonly|inactive)$/, (m) => ({
    sendrecv: 'Direction: send AND receive (normal two-way call).',
    sendonly: 'Direction: send only (e.g. putting the other side on hold).',
    recvonly: 'Direction: receive only (e.g. audio-only user receiving video, or listener).',
    inactive: 'Direction: nothing flows (call on hold).',
  }[m[1]]), true],
  [/^a=msid:(\S+) (\S+)/, (m) => `Links this media to MediaStream "${m[1]}" and track "${m[2]}". This is what fills event.streams in ontrack.`],
  [/^a=msid:/, 'Links this media to a MediaStream/track.'],
  [/^a=rtcp-mux-only/, 'RTP and RTCP MUST share one port.'],
  [/^a=rtcp-mux/, 'RTP (media) and RTCP (control/stats) share one port. Fewer ports, easier NAT traversal.'],
  [/^a=rtcp-rsize/, 'Allows smaller RTCP packets.'],
  [/^a=rtpmap:(\d+) ([^/]+)\/(\d+)(?:\/(\d+))?/, (m) =>
    `Payload type ${m[1]} = ${CODECS[m[2]] ?? m[2]} · clock ${m[3]} Hz${m[4] ? ` · ${m[4]} channels` : ''}`, true],
  [/^a=rtcp-fb:(\S+) transport-cc/, (m) => `PT ${m[1]}: transport-wide congestion control feedback → bandwidth estimation (adapts quality to the network).`],
  [/^a=rtcp-fb:(\S+) goog-remb/, (m) => `PT ${m[1]}: REMB, older bandwidth estimation feedback.`],
  [/^a=rtcp-fb:(\S+) nack pli/, (m) => `PT ${m[1]}: PLI, "Picture Loss Indication": asks the sender for a new keyframe when video breaks.`],
  [/^a=rtcp-fb:(\S+) nack$/, (m) => `PT ${m[1]}: NACK, the receiver can request lost packets again.`],
  [/^a=rtcp-fb:(\S+) ccm fir/, (m) => `PT ${m[1]}: FIR, "Full Intra Request": another way to ask for a keyframe.`],
  [/^a=rtcp-xr:/, 'RTCP extended reports (e.g. measuring round-trip time from the receiver side).'],
  [/^a=rtcp-fb:/, 'RTCP feedback mechanism for this payload type.'],
  [/^a=fmtp:(\d+) apt=(\d+)/, (m) => `PT ${m[1]} is the retransmission (RTX) stream for PT ${m[2]}.`],
  [/^a=fmtp:(\d+) (.*useinbandfec=1.*)/, (m) => `Opus settings for PT ${m[1]}: useinbandfec=1 = built-in loss recovery; minptime = shortest packet in ms.`],
  [/^a=fmtp:(\d+) (.*profile-level-id=([0-9a-f]+).*)/i, (m) =>
    `H.264 settings for PT ${m[1]}: profile-level-id ${m[3]} (profile + max resolution); packetization-mode; both sides must match.`],
  [/^a=fmtp:(\d+) (.*)/, (m) => `Codec parameters for PT ${m[1]}: ${m[2]}`],
  [/^a=ssrc-group:FID (\d+) (\d+)/, (m) => `SSRC ${m[1]} (media) is paired with SSRC ${m[2]} (its retransmissions).`],
  [/^a=ssrc:(\d+) cname:(.*)/, (m) => `SSRC ${m[1]} = the numeric id stamped on every RTP packet of this stream. cname "${m[2]}" groups streams to sync (lip-sync).`],
  [/^a=ssrc:(\d+) msid/, (m) => `SSRC ${m[1]} belongs to this MediaStream/track (legacy form of a=msid).`],
  [/^a=ssrc:/, 'Legacy SSRC attribute.'],
  [/^a=sctp-port:(\d+)/, (m) => `SCTP port ${m[1]} for the data channel (inside the DTLS connection, not a real UDP port).`],
  [/^a=max-message-size:(\d+)/, (m) => `Largest data channel message the other side may send: ${Number(m[1]).toLocaleString()} bytes.`],
  [/^a=simulcast|^a=rid/, 'Simulcast: sends the same video at several qualities (used with SFUs in group calls).'],
];

function explainLine(line) {
  for (const [re, text, key] of RULES) {
    const m = line.match(re);
    if (m) return { why: typeof text === 'function' ? text(m) : text, key: !!key };
  }
  return { why: '', key: false };
}

// ---------------------------------------------------------------------
// Split SDP into session part + one part per m= line.
// ---------------------------------------------------------------------
function parseSections(sdp) {
  const lines = sdp.split(/\r?\n/).filter(Boolean);
  const sections = [{ kind: 'session', lines: [] }];
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push({ kind: line.slice(2).split(' ')[0], lines: [] });
    sections.at(-1).lines.push(line);
  }
  for (const s of sections) {
    const find = (re) => s.lines.map((l) => l.match(re)).find(Boolean);
    s.mid = find(/^a=mid:(.*)/)?.[1];
    s.direction = find(/^a=(sendrecv|sendonly|recvonly|inactive)$/)?.[1];
    s.setup = find(/^a=setup:(.*)/)?.[1];
    s.codecs = s.lines.map((l) => l.match(/^a=rtpmap:\d+ ([^/]+)/)?.[1]).filter(Boolean);
    s.candidates = s.lines.filter((l) => l.startsWith('a=candidate:')).length;
  }
  return sections;
}

// ---------------------------------------------------------------------
// Render annotated SDP
// ---------------------------------------------------------------------
function renderSdp(container, sdp) {
  const dim = $('optDim').checked;
  container.innerHTML = '';
  for (const s of parseSections(sdp)) {
    const box = document.createElement('div');
    box.className = `section ${s.kind}`;
    const title = s.kind === 'session'
      ? 'Session level (applies to the whole call)'
      : `m=${s.kind} section${s.mid !== undefined ? ` (mid ${s.mid})` : ''}`;
    box.innerHTML = `<div class="section-title">${title}</div>`;
    for (const line of s.lines) {
      const { why, key } = explainLine(line);
      const row = document.createElement('div');
      const isCand = line.startsWith('a=candidate:');
      row.className = `row${key ? ' key' : ''}${isCand ? ' cand' : ''}${dim && !key && !isCand ? ' dim' : ''}`;
      row.innerHTML = '<code></code><span class="why"></span>';
      row.children[0].textContent = line;
      row.children[1].textContent = why;
      box.appendChild(row);
    }
    container.appendChild(box);
  }
}

// ---------------------------------------------------------------------
// Offer vs answer comparison: shows what negotiation actually decided.
// ---------------------------------------------------------------------
function renderSummary(offerSdp, answerSdp) {
  const offer = parseSections(offerSdp).slice(1);
  const answer = parseSections(answerSdp).slice(1);
  const main = (codecs) => codecs.filter((c) => !['rtx', 'red', 'ulpfec', 'flexfec', 'CN', 'telephone-event'].includes(c));
  let html = '<table><tr><th>Section</th><th>Offer (A proposes)</th><th>Answer (B decides)</th><th>What it means</th></tr>';
  offer.forEach((o, i) => {
    const a = answer[i] ?? {};
    html += `<tr><td><b>m=${o.kind}</b></td>
      <td>${o.codecs.length} payload types<br>main codecs: ${[...new Set(main(o.codecs))].join(', ') || '—'}<br>direction: ${o.direction ?? '—'} · setup: ${o.setup}</td>
      <td>${a.codecs?.length ?? 0} payload types<br>main codecs: ${[...new Set(main(a.codecs ?? []))].join(', ') || '—'}<br>direction: ${a.direction ?? '—'} · setup: ${a.setup}</td>
      <td>The answer can only pick from what the offer listed. The first codec in the answer's m= line is what will actually be used.
          setup ${o.setup} → ${a.setup}: B chose its DTLS role.
          ${o.direction && a.direction && o.direction !== a.direction
            ? `<br><b>direction ${o.direction} → ${a.direction}</b>: B has no track to send here (we added none), so B answers that it will only receive.`
            : ''}</td></tr>`;
  });
  $('summary').innerHTML = html + '</table>';
}

// ---------------------------------------------------------------------
// ICE candidates
// "candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0 ufrag abcd network-id 1"
// ---------------------------------------------------------------------
function parseCandidate(str) {
  const f = str.replace(/^a=/, '').replace(/^candidate:/, '').trim().split(/\s+/);
  const c = { foundation: f[0], component: f[1], protocol: f[2], priority: Number(f[3]),
              address: f[4], port: f[5], type: f[7] };
  for (let i = 8; i + 1 < f.length; i += 2) c[f[i]] = f[i + 1];
  return c;
}

const TYPE_MEANING = {
  host: 'HOST: an address of this device\'s own network card. Works on the same LAN. (Chrome hides the real IP behind a random "xxxx.local" mDNS name for privacy.)',
  srflx: 'SERVER-REFLEXIVE: your PUBLIC IP:port as seen by the STUN server, i.e. your router\'s outside address. This is what lets two phones on different networks connect.',
  prflx: 'PEER-REFLEXIVE: discovered during connectivity checks (the other peer saw us from an address we didn\'t know about).',
  relay: 'RELAY: an address on a TURN server. Media goes through your server. Always works, costs bandwidth.',
};

function renderCandidates(list) {
  if (!list.length) {
    $('candidates').innerHTML = '<p>No candidates.</p>';
    return;
  }
  let html = `<table><tr><th>Peer</th><th>type</th><th>proto</th><th>address : port</th>
    <th>priority → type pref</th><th>related (raddr)</th><th>meaning</th></tr>`;
  for (const { peer, raw } of list) {
    const c = parseCandidate(raw);
    // priority = (typePref << 24) + (localPref << 8) + (256 - component)
    const typePref = c.priority >>> 24;
    html += `<tr><td>${peer}</td><td><b>${c.type}</b></td><td>${c.protocol}${c.tcptype ? ` (${c.tcptype})` : ''}</td>
      <td class="mono">${c.address} : ${c.port}</td>
      <td class="mono">${c.priority}<br>→ ${typePref}</td>
      <td class="mono">${c.raddr ? `${c.raddr} : ${c.rport}` : '—'}</td>
      <td>${TYPE_MEANING[c.type] ?? ''}</td></tr>`;
  }
  html += `</table><p class="sub">Raw example: <code>${list[0].raw}</code><br>
    Fields: <code>candidate:&lt;foundation&gt; &lt;component 1=RTP&gt; &lt;protocol&gt; &lt;priority&gt; &lt;address&gt; &lt;port&gt; typ &lt;type&gt; [raddr/rport] …</code><br>
    Type preference (top 8 bits of priority): host 126 &gt; prflx 110 &gt; srflx 100 &gt; relay 0. ICE tries higher-priority pairs first,
    which is why a direct path wins over TURN whenever both work.</p>`;
  $('candidates').innerHTML = html;
}

// ---------------------------------------------------------------------
// Negotiate locally and wait for ICE gathering to complete.
// ---------------------------------------------------------------------
let pcs = [];

function waitForGathering(pc, ms = 6000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve(true);
    const timer = setTimeout(() => resolve(false), ms); // STUN may be blocked
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(true); }
    });
  });
}

async function generate() {
  pcs.forEach((pc) => pc.close());
  const wantAudio = $('optAudio').checked, wantVideo = $('optVideo').checked, wantData = $('optData').checked;
  if (!wantAudio && !wantVideo && !wantData) {
    $('status').textContent = 'Pick at least one of audio / video / data channel: with no m= sections there is nothing to negotiate.';
    return;
  }

  const config = { iceServers: $('optStun').checked ? [{ urls: 'stun:stun.l.google.com:19302' }] : [] };
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  pcs = [a, b];

  const candidates = [];
  a.onicecandidate = (e) => e.candidate && candidates.push({ peer: 'A', raw: e.candidate.candidate });
  b.onicecandidate = (e) => e.candidate && candidates.push({ peer: 'B', raw: e.candidate.candidate });

  // Transceivers without a real track: enough to produce the SDP.
  if (wantAudio) a.addTransceiver('audio', { direction: 'sendrecv' });
  if (wantVideo) a.addTransceiver('video', { direction: 'sendrecv' });
  if (wantData) a.createDataChannel('chat');

  $('status').textContent = 'Negotiating…';
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(answer);

  $('status').textContent = 'Waiting for ICE gathering to complete…';
  const [okA, okB] = await Promise.all([waitForGathering(a), waitForGathering(b)]);

  // pc.localDescription = the SDP we set + every candidate gathered so far.
  const fullOffer = a.localDescription.sdp;
  const fullAnswer = b.localDescription.sdp;
  const count = (sdp) => sdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:')).length;

  $('status').textContent =
    `offer from createOffer():         ${offer.sdp.split('\r\n').length - 1} lines, ${count(offer.sdp)} candidates\n` +
    `a.localDescription after gathering: ${fullOffer.split('\r\n').length - 1} lines, ${count(fullOffer)} candidates\n` +
    `→ With trickle ICE we send the SDP immediately and the candidates separately as they are found.\n` +
    `  Without trickle you'd wait for gathering (can take seconds with STUN/TURN) and send the full SDP once.` +
    (okA && okB ? '' : '\n⚠ Gathering timed out (STUN server unreachable?). Showing what was found.');

  renderSummary(fullOffer, fullAnswer);
  renderSdp($('offer'), fullOffer);
  renderSdp($('answer'), fullAnswer);
  renderCandidates(candidates);
  console.log('OFFER\n' + fullOffer);
  console.log('ANSWER\n' + fullAnswer);
}

$('run').addEventListener('click', () =>
  generate().catch((e) => ($('status').textContent = `❌ ${e.name}: ${e.message}`)));
$('explainPaste').addEventListener('click', () => renderSdp($('pasted'), $('paste').value));
