// Turns pc.getStats() into a small summary: which network path, codecs, bitrate, RTT, loss.
// `prev` keeps last byte counters so we can compute bitrates between calls.
export async function readStats(pc, prev) {
  const report = await pc.getStats();
  const out = { path: null, rttMs: null, send: {}, recv: {} };

  let pair = null;
  report.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = report.get(r.selectedCandidatePairId);
  });
  if (!pair) report.forEach((r) => {
    if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
  });
  if (pair) {
    const l = report.get(pair.localCandidateId);
    const r = report.get(pair.remoteCandidateId);
    out.path = {
      local: l?.candidateType, remote: r?.candidateType,
      protocol: l?.relayProtocol ? `${l.protocol} via TURN/${l.relayProtocol}` : l?.protocol,
      remoteAddress: r?.address || r?.ip || '(hidden)', remotePort: r?.port,
    };
    if (pair.currentRoundTripTime != null) out.rttMs = Math.round(pair.currentRoundTripTime * 1000);
  }

  report.forEach((r) => {
    if (r.type !== 'outbound-rtp' && r.type !== 'inbound-rtp') return;
    const dir = r.type === 'outbound-rtp' ? 'send' : 'recv';
    const bytes = dir === 'send' ? r.bytesSent : r.bytesReceived;
    const last = prev[r.id];
    const kbps = last ? Math.round(((bytes - last.bytes) * 8) / (r.timestamp - last.ts)) : null; // bits per ms = kbps
    prev[r.id] = { bytes, ts: r.timestamp };
    out[dir][r.kind] = {
      codec: report.get(r.codecId)?.mimeType?.split('/')[1],
      kbps,
      resolution: r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : null,
      fps: r.framesPerSecond ?? null,
      packetsLost: dir === 'recv' ? r.packetsLost : null,
    };
  });
  return out;
}

export function describePath(path) {
  if (!path) return '';
  if (path.local === 'relay' || path.remote === 'relay')
    return 'Media is RELAYED through a TURN server: no direct path was possible.';
  if (path.local === 'srflx' || path.remote === 'srflx' || path.local === 'prflx' || path.remote === 'prflx')
    return 'Direct peer-to-peer across the internet: the NAT was traversed using the public address from STUN.';
  return 'Direct peer-to-peer on the same local network (host candidates).';
}
