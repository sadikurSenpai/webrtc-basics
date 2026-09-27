// CallManager: everything WebRTC for ONE call at a time.
//
// Caller                         signal server                        Callee
//  getUserMedia
//  call.invite ───────────────────►  ringing  ─────────────► call.incoming
//                                                             getUserMedia
//                                                             new RTCPeerConnection + addTrack
//  call.accepted ◄───────────────── accepted ◄──────────────── call.accept
//  new RTCPeerConnection + addTrack
//  createOffer / setLocalDescription
//  webrtc.offer  ─────────────────────────────────────────────► setRemoteDescription
//                                                               createAnswer / setLocalDescription
//  setRemoteDescription ◄───────────────────────────────────── webrtc.answer
//  webrtc.candidate  ◄────────────── (both ways) ─────────────► webrtc.candidate
//  ════════════════════ media flows directly (or via TURN) ═════════════════════
//  call.hangup ───────────────────► ended ───────────────────► call.ended
import { log, phase } from './timeline.js';
import { describePath, readStats } from './stats.js';
import { CallRecorder } from './recorder.js';

const CANDIDATE_WHY = {
  host: "This device's own IP on its local network. Works when both devices are on the same network.",
  srflx: 'Our PUBLIC ip:port as seen by the STUN server. Lets devices on different networks reach each other.',
  prflx: 'Discovered while testing connectivity (the peer saw us from an address we didn\'t know).',
  relay: 'An address on a TURN server. Media would go through that server. Works almost everywhere.',
};

const SIGNALING_WHY = {
  stable: 'No offer/answer in progress: either not started yet, or negotiation is complete.',
  'have-local-offer': 'We made an offer and are waiting for the answer.',
  'have-remote-offer': 'We received an offer and must reply with an answer.',
  closed: 'The peer connection is closed.',
};

const ICE_WHY = {
  checking: 'ICE is sending connectivity checks (STUN pings) on candidate pairs to find one that works.',
  connected: 'ICE found a working candidate pair.',
  completed: 'ICE finished checking all pairs.',
  disconnected: 'Checks are failing right now (network blip?). Might recover by itself.',
  failed: 'No candidate pair worked.',
};

const CONNECTION_WHY = {
  connecting: 'ICE is finding a path and DTLS is doing the encryption handshake (keys checked against the SDP fingerprint).',
  connected: 'A path is found and encrypted. Audio/video now flow directly between the two browsers. The signal server is no longer in the media path.',
  disconnected: 'Lost contact with the other peer. May recover on its own; a production app would try an ICE restart (new offer with new ICE credentials).',
  failed: 'ICE could not find ANY working path. Typical when both sides are behind strict NATs/firewalls: a TURN server is needed (Step 5).',
};

function parseCandidate(c) {
  const f = (c || '').split(' ');
  return { protocol: f[2], address: f[4], port: f[5], type: c?.match(/ typ (\w+)/)?.[1] };
}

// One-line summary of an SDP: what media, which codec is first, direction.
function summarizeSdp(sdp) {
  const parts = [];
  let current = null;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      const [kind, , , firstPt] = line.slice(2).split(' ');
      current = { kind, firstPt, codec: null, dir: null };
      parts.push(current);
    } else if (current && line.startsWith(`a=rtpmap:${current.firstPt} `)) {
      current.codec = line.split(' ')[1].split('/')[0];
    } else if (current && /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) {
      current.dir = line.slice(2);
    }
  }
  const fp = sdp.match(/a=fingerprint:(\S+)/)?.[1];
  return parts.map((p) => `${p.kind}: ${p.codec ?? 'data'}${p.dir ? `, ${p.dir}` : ''}`).join(' · ') +
    (fp ? ` · DTLS fingerprint (${fp})` : '');
}

export class CallManager {
  constructor({ signaling, iceServers, onChange, onEnded, onStats }) {
    this.signaling = signaling;
    this.iceServers = iceServers;
    this.onChange = onChange;
    this.onEnded = onEnded;
    this.onStats = onStats;
    this.reset();
  }

  reset() {
    this.state = 'idle'; // idle | outgoing | incoming | connecting | active
    this.call = null; // { id, peer: {id, username}, media, role }
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingCandidates = [];
    this.mic = true;
    this.cam = true;
    this.remoteMedia = { audio: true, video: true };
    this.startedAt = null;
    this.stats = null;
    this.prevStats = {};
    this.loggedPath = false;
    this.recorder = null;
    clearInterval(this.statsTimer);
  }

  setState(state) {
    this.state = state;
    this.onChange();
  }

  // ================================================================ outgoing

  async startCall(friend, media) {
    if (this.state !== 'idle') return;
    phase(`📞 Calling ${friend.username} (${media} call)`);
    this.call = { id: null, peer: friend, media, role: 'caller' };
    this.setState('outgoing');

    phase('Step 1 · Get camera/microphone');
    if (!(await this.getMedia(media))) return this.finish('Could not access camera/microphone');
    if (this.state !== 'outgoing') return; // cancelled during the permission prompt

    phase('Step 2 · Ring the other person through the signal server');
    this.signaling.send('call.invite', { to_user_id: friend.id, media });
  }

  // ================================================================ incoming

  onIncoming(msg) {
    if (this.state !== 'idle') return; // the server already prevents this (busy check)
    phase(`📲 Incoming ${msg.media} call from ${msg.from_user.username}`);
    this.call = { id: msg.call_id, peer: msg.from_user, media: msg.media, role: 'callee' };
    this.setState('incoming');
  }

  async accept() {
    if (this.state !== 'incoming') return;
    const call = this.call;
    this.setState('connecting');

    phase('Step 1 · Get camera/microphone');
    if (!(await this.getMedia(call.media))) {
      this.signaling.send('call.decline', { call_id: call.id });
      return this.finish('Could not access camera/microphone');
    }
    if (this.call !== call) return; // caller cancelled while we were waiting for permission

    phase('Step 2 · Prepare the peer connection, then accept');
    this.createPeerConnection();
    this.signaling.send('call.accept', { call_id: call.id });
  }

  decline() {
    if (this.state === 'incoming') this.hangup('declined');
  }

  // ================================================================== media

  async getMedia(media) {
    if (!navigator.mediaDevices?.getUserMedia) {
      log('error', 'Camera/mic API unavailable', {
        why: 'Browsers only allow camera/mic on HTTPS or localhost. Open the app through the https:// ngrok URL.',
      });
      return false;
    }
    const constraints = {
      audio: { echoCancellation: true, noiseSuppression: true },
      video: media === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 } } : false,
    };
    log('media', `navigator.mediaDevices.getUserMedia(${JSON.stringify({ audio: true, video: media === 'video' })})`, {
      why: 'Ask the browser/OS for the mic (and camera). A permission prompt appears the first time. On mobile this is the OS permission dialog.',
      detail: constraints,
    });

    const call = this.call;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      log('error', `getUserMedia failed: ${e.name}`, {
        why: {
          NotAllowedError: 'Permission denied. Allow camera/mic for this site in the browser address bar.',
          NotFoundError: 'No camera/microphone found on this device.',
          NotReadableError: 'The device is busy (another app or tab is using the camera).',
        }[e.name] ?? e.message,
      });
      return false;
    }
    if (this.call !== call) { // call ended while the prompt was open
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    for (const track of stream.getTracks()) {
      log('media', `Got local ${track.kind} track: "${track.label}"`, {
        why: track.kind === 'audio'
          ? 'A MediaStreamTrack of mic audio. Echo cancellation keeps the other person from hearing themselves.'
          : 'A MediaStreamTrack of camera frames. Shown in our own preview (muted), and soon sent to the peer.',
      });
    }
    this.localStream = stream;
    this.mic = true;
    this.cam = media === 'video';
    this.onChange();
    return true;
  }

  // ======================================================= peer connection

  createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    log('pc', `new RTCPeerConnection({ iceServers: [${this.iceServers.length} server(s)] })`, {
      why: 'The object that does all the WebRTC work: negotiation, ICE, encryption, sending and receiving media. The STUN/TURN list came from the backend (GET /api/config).',
      detail: this.iceServers,
    });

    pc.onicecandidate = ({ candidate }) => {
      if (!this.call?.id) return;
      if (!candidate) {
        log('ice', 'ICE gathering finished', { why: 'No more local candidates to find. Each one was already sent as it was found (trickle ICE).' });
        return;
      }
      const c = parseCandidate(candidate.candidate);
      if (c.type) {
        log('ice', `Found local candidate: ${c.type} ${c.protocol} ${c.address}:${c.port}`, {
          why: CANDIDATE_WHY[c.type], detail: candidate.candidate,
        });
      }
      this.signaling.send('webrtc.candidate', { call_id: this.call.id, candidate: candidate.toJSON() });
    };

    pc.ontrack = (event) => {
      log('media', `ontrack: receiving remote ${event.track.kind}`, {
        why: 'The remote SDP told us media is coming. Packets start flowing once ICE + DTLS are connected.',
      });
      this.remoteStream = event.streams[0] ?? new MediaStream([event.track]);
      this.onChange();
    };

    pc.onsignalingstatechange = () =>
      log('pc', `signalingState → ${pc.signalingState}`, { why: SIGNALING_WHY[pc.signalingState] });
    pc.onicegatheringstatechange = () =>
      log('pc', `iceGatheringState → ${pc.iceGatheringState}`, {
        why: pc.iceGatheringState === 'gathering'
          ? 'Collecting local candidates: network interfaces (host), STUN (srflx), TURN (relay).' : undefined,
      });
    pc.oniceconnectionstatechange = () =>
      log('pc', `iceConnectionState → ${pc.iceConnectionState}`, { why: ICE_WHY[pc.iceConnectionState] });
    pc.onconnectionstatechange = () => this.onConnectionState(pc.connectionState);

    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
      log('pc', `addTrack(${track.kind})`, {
        why: 'Attach our media BEFORE the offer/answer is created, so the SDP announces "I will send this".',
      });
    }
  }

  onConnectionState(state) {
    log(state === 'failed' ? 'error' : 'pc', `connectionState → ${state}`, { why: CONNECTION_WHY[state] });
    if (state === 'connected' && this.state !== 'active') {
      phase('✅ Connected: media is flowing peer-to-peer');
      this.startedAt = Date.now();
      this.setState('active');
      this.startStats();
      // Silent: nothing in the UI or timeline; progress only in the console (debug level) and backend logs.
      this.recorder = new CallRecorder({ callId: this.call.id, localStream: this.localStream, remoteStream: this.remoteStream });
      this.recorder.start();
    } else if (state === 'failed') {
      this.hangup('ice_failed');
    }
  }

  // ============================================================ negotiation

  async onAccepted(msg) {
    if (!this.call || msg.call_id !== this.call.id) return;
    if (msg.role !== 'caller') {
      phase('Step 3 · Wait for the caller\'s OFFER');
      return;
    }
    this.setState('connecting');
    phase('Step 3 · Create the OFFER and send it');
    this.createPeerConnection();

    const offer = await this.pc.createOffer();
    log('sdp', `createOffer() → ${offer.sdp.split('\r\n').length} lines of SDP`, {
      why: `Our proposal: ${summarizeSdp(offer.sdp)}`, detail: offer.sdp,
    });
    await this.pc.setLocalDescription(offer);
    log('sdp', 'setLocalDescription(offer)', {
      why: 'Commit to our offer. This also STARTS ICE gathering, so candidates appear right after.',
    });
    this.signaling.send('webrtc.offer', { call_id: this.call.id, sdp: offer.sdp });
  }

  async onOffer(msg) {
    if (!this.pc || msg.call_id !== this.call?.id) return;
    await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    log('sdp', 'setRemoteDescription(offer)', {
      why: `Now we know what the caller proposes: ${summarizeSdp(msg.sdp)}`,
    });
    await this.flushCandidates();

    phase('Step 4 · Create the ANSWER and send it back');
    const answer = await this.pc.createAnswer();
    log('sdp', `createAnswer() → ${answer.sdp.split('\r\n').length} lines of SDP`, {
      why: `We pick from what they offered: ${summarizeSdp(answer.sdp)}`, detail: answer.sdp,
    });
    await this.pc.setLocalDescription(answer);
    log('sdp', 'setLocalDescription(answer)', { why: 'Commit to our answer; our ICE gathering starts now.' });
    this.signaling.send('webrtc.answer', { call_id: this.call.id, sdp: answer.sdp });
    phase('Step 5 · ICE: test candidate pairs until one works');
  }

  async onAnswer(msg) {
    if (!this.pc || msg.call_id !== this.call?.id) return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    log('sdp', 'setRemoteDescription(answer)', {
      why: `Offer/answer complete. Agreed: ${summarizeSdp(msg.sdp)}`,
    });
    await this.flushCandidates();
    phase('Step 5 · ICE: test candidate pairs until one works');
  }

  async onCandidate(msg) {
    if (!this.pc || msg.call_id !== this.call?.id) return;
    const c = parseCandidate(msg.candidate?.candidate);
    if (!this.pc.remoteDescription) {
      this.pendingCandidates.push(msg.candidate);
      log('ice', `Queued remote candidate (${c.type ?? 'end'}): no remote description yet`, {
        why: 'Candidates can arrive before the offer/answer is applied. addIceCandidate() would fail now, so we keep them for later.',
      });
      return;
    }
    await this.addCandidate(msg.candidate);
  }

  async addCandidate(candidate) {
    const c = parseCandidate(candidate?.candidate);
    try {
      await this.pc.addIceCandidate(candidate);
      if (c.type) {
        log('ice', `addIceCandidate(remote ${c.type} ${c.address}:${c.port})`, {
          why: 'Hand the peer\'s address to ICE. ICE pairs it with our local candidates and tests each pair.',
        });
      }
    } catch (e) {
      log('error', `addIceCandidate failed: ${e.message}`);
    }
  }

  async flushCandidates() {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    if (queued.length) log('ice', `Applying ${queued.length} queued remote candidate(s)`);
    for (const c of queued) await this.addCandidate(c);
  }

  // =============================================================== controls

  toggleMic() {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.mic = track.enabled;
    log('media', `Microphone ${track.enabled ? 'ON' : 'MUTED'}: audioTrack.enabled = ${track.enabled}`, {
      why: 'A disabled track sends silence. No new offer/answer and no renegotiation: the connection stays exactly the same.',
    });
    this.sendMediaState();
    this.onChange();
  }

  toggleCam() {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.cam = track.enabled;
    this.recorder?.setVideoEnabled(track.enabled);
    log('media', `Camera ${track.enabled ? 'ON' : 'OFF'}: videoTrack.enabled = ${track.enabled}`, {
      why: 'A disabled video track sends black frames (almost no bandwidth), again without renegotiation. ' +
        'To also turn the camera light off, apps stop the track and later swap in a new one with sender.replaceTrack().',
    });
    this.sendMediaState();
    this.onChange();
  }

  sendMediaState() {
    if (this.call?.id && (this.state === 'connecting' || this.state === 'active')) {
      this.signaling.send('media.state', { call_id: this.call.id, audio: this.mic, video: this.cam });
    }
  }

  onRemoteMediaState(msg) {
    if (msg.call_id !== this.call?.id) return;
    this.remoteMedia = { audio: msg.audio, video: msg.video };
    this.onChange();
  }

  // ================================================================= ending

  hangup(reason = 'hangup') {
    if (!this.call) return;
    const id = this.call.id;
    if (id) {
      if (this.state === 'outgoing') this.signaling.send('call.cancel', { call_id: id });
      else if (this.state === 'incoming') this.signaling.send('call.decline', { call_id: id });
      else this.signaling.send('call.hangup', { call_id: id, reason });
    }
    this.finish({ hangup: 'You ended the call', declined: 'You declined the call', ice_failed: 'Connection failed (no network path; TURN needed?)' }[reason] ?? `Call ended (${reason})`);
  }

  onRinging(msg) {
    if (this.state === 'outgoing' && this.call && !this.call.id) {
      this.call.id = msg.call_id;
      phase(`🔔 Ringing ${msg.to_user.username}…`);
      this.onChange();
    } else {
      // We cancelled before the server told us the call id; cancel it now.
      this.signaling.send('call.cancel', { call_id: msg.call_id });
    }
  }

  onEndedMessage(msg) {
    if (!this.call || msg.call_id !== this.call.id) return; // we already cleaned up
    const text = {
      declined: `${this.call.peer.username} declined`,
      missed: 'No answer',
      cancelled: `${this.call.peer.username} cancelled the call`,
      ended: `${msg.by} ended the call`,
      failed: `Call failed (${msg.reason})`,
    }[msg.status] ?? `Call ended (${msg.status})`;
    this.finish(text);
  }

  onError(msg) {
    // Our invite was refused (offline, busy, not friends).
    if (this.state === 'outgoing' && !this.call?.id) this.finish(msg.message);
  }

  finish(text) {
    if (!this.call && !this.localStream) return;
    phase(`📴 ${text}`);
    this.recorder?.stop(); // flushes the last chunk + finishes uploads in the background
    if (this.pc) {
      this.pc.close();
      log('pc', 'pc.close()', {
        why: 'Stops ICE, DTLS and all media for this call. The other side learns it from the signaling message, not from WebRTC.',
      });
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      log('media', 'Stopped local tracks: camera/mic released');
    }
    this.reset();
    this.onChange();
    this.onEnded?.(text);
  }

  // ================================================================== stats

  startStats() {
    clearInterval(this.statsTimer);
    this.statsTimer = setInterval(async () => {
      if (!this.pc) return;
      this.stats = await readStats(this.pc, this.prevStats);
      if (!this.loggedPath && this.stats.path) {
        this.loggedPath = true;
        const p = this.stats.path;
        log('stats', `Chosen path: local ${p.local} ⇄ remote ${p.remote} over ${p.protocol}`, { why: describePath(p) });
      }
      this.onStats?.(this.stats);
    }, 1000);
  }
}
