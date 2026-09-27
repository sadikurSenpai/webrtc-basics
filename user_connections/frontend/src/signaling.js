// WebSocket client for the SIGNAL SERVER.
// This is the real version of Step 1's fake `signal()` function.
import { log } from './timeline.js';

function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`; // proxied to SIGNAL_SERVER_URL by Vite
}

// What each message type means, shown in the timeline.
const WHY = {
  'auth': 'First message on a new WebSocket: prove who we are with the JWT from the backend login.',
  'auth.ok': 'The signal server verified our token itself (it shares the JWT secret with the backend).',
  'call.invite': 'Ask the signal server to ring the other person. No WebRTC yet: first we find out if they want to talk.',
  'call.ringing': 'The server accepted our invite and is ringing the other side.',
  'call.incoming': 'Someone is calling us. Nothing WebRTC-related has happened yet.',
  'call.accept': 'Tell the caller (via server) we picked up. Our RTCPeerConnection is ready for their offer.',
  'call.accepted': 'Both sides agreed to talk. Now the WebRTC negotiation (offer/answer/ICE) starts.',
  'call.decline': 'Tell the caller (via server) we don\'t want to talk.',
  'call.cancel': 'Caller gives up before the other side answered.',
  'call.hangup': 'Tell the other side (via server) the call is over, so they don\'t wait for a timeout.',
  'call.ended': 'The server closed the call and saved its final status in the backend DB.',
  'webrtc.offer': 'The caller\'s SDP: "here are the media + codecs I can send and receive, and my encryption fingerprint".',
  'webrtc.answer': 'The callee\'s SDP: "of what you offered, here is what I accept", plus its own fingerprint.',
  'webrtc.candidate': 'One network address where the peer might be reachable. Sent as soon as it is found (trickle ICE).',
  'media.state': 'App-level info: mic/camera on or off. Not part of WebRTC itself; just so the UI can show an icon.',
  'presence': 'A friend connected to / disconnected from the signal server.',
  'error': 'The signal server refused a request.',
};

export class Signaling {
  constructor({ token, onMessage, onStatus }) {
    this.url = import.meta.env.VITE_SIGNAL_WS_URL || defaultUrl();
    this.token = token;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.closedByUs = false;
    this.retry = 0;
  }

  connect() {
    this.onStatus('connecting');
    log('signal-out', `Opening WebSocket ${this.url}`, {
      why: 'One long-lived connection to the signal server. It is how the server can push "incoming call" to us at any time.',
    });
    const ws = (this.ws = new WebSocket(this.url));

    ws.onopen = () => {
      this.retry = 0;
      this.#rawSend({ type: 'auth', token: this.token }, { detail: { type: 'auth', token: '<JWT hidden>' } });
      clearInterval(this.pinger);
      // Keep-alive: proxies/tunnels close idle WebSockets.
      this.pinger = setInterval(() => this.#rawSend({ type: 'ping' }, { quiet: true }), 25000);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'pong') return;
      if (msg.type === 'auth.ok') this.onStatus('online');
      const { trace, ...rest } = msg;
      log('signal-in', `${msg.type}${describe(msg)}`, { why: WHY[msg.type], trace, detail: abbreviate(rest) });
      this.onMessage(msg);
    };

    ws.onclose = (event) => {
      clearInterval(this.pinger);
      this.onStatus('offline');
      log('signal-in', `WebSocket closed (code ${event.code})`, {
        why: event.code === 4000 ? 'You opened the app in another tab; the newest connection wins.'
          : event.code === 4401 ? 'The signal server rejected our token.'
          : 'Connection lost. We will try to reconnect.',
      });
      if (this.closedByUs || event.code === 4000 || event.code === 4401) return;
      const delay = Math.min(1000 * 2 ** this.retry++, 15000);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(type, data = {}) {
    const msg = { type, ...data };
    this.#rawSend(msg, { detail: abbreviate(msg) });
  }

  #rawSend(msg, { detail, quiet = false } = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      log('error', `Can't send ${msg.type}: signal server not connected`);
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    if (!quiet) log('signal-out', `${msg.type}${describe(msg)}`, { why: WHY[msg.type], detail });
    return true;
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.pinger);
    this.ws?.close();
  }
}

// Short summary appended to the title, e.g. "webrtc.candidate (srflx udp)".
function describe(msg) {
  if (msg.type === 'webrtc.candidate') {
    const c = msg.candidate?.candidate ?? '';
    const type = c.match(/ typ (\w+)/)?.[1];
    return type ? `  (${type} ${c.split(' ')[2] ?? ''})` : '  (end of candidates)';
  }
  if (msg.sdp) return `  (${msg.sdp.length.toLocaleString()} chars of SDP)`;
  if (msg.type === 'error') return `: ${msg.message}`;
  if (msg.type === 'call.ended') return `: ${msg.status} (${msg.reason})`;
  if (msg.type === 'media.state') return `: mic ${msg.audio ? 'on' : 'off'}, camera ${msg.video ? 'on' : 'off'}`;
  return '';
}

// SDP is long; show it as text so it's readable in the timeline.
function abbreviate(msg) {
  if (msg.sdp) return `${JSON.stringify({ ...msg, sdp: '…see below…' }, null, 2)}\n\n${msg.sdp}`;
  return msg;
}
