// Records THIS side of a call and uploads it to S3 in 10-second chunks.
//
//   own camera ── clone, downscale 320×240@15fps ─────────────► video ┐
//   own mic ──────┐                                                    ├─► MediaRecorder ─► chunk every 10 s
//   remote voice ─┴─► AudioContext mixer ──────────────────────► audio ┘         │
//                                                                                 ▼
//                      PUT to a presigned S3 URL (from the backend, in batches of 60)
//
// So each side's file has that person's video + the WHOLE conversation's audio.
// The backend never receives media bytes; it only signs URLs and stores metadata.
// It is kept light on the device: small video, low bitrate, one upload at a time.
import { api } from './api.js';

const CHUNK_MS = 10_000;
const VIDEO_BITS_PER_SECOND = 250_000;
const AUDIO_BITS_PER_SECOND = 32_000;
const MAX_PENDING_BYTES = 30e6; // if uploads stall this long, drop new chunks rather than eat memory
const PREFETCH_WHEN_LEFT = 5; // ask for more upload URLs before running out

const debug = (...args) => console.debug('[recorder]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickMimeType(hasVideo) {
  const candidates = hasVideo
    ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return candidates.find((t) => MediaRecorder.isTypeSupported?.(t));
}

export class CallRecorder {
  constructor({ callId, localStream, remoteStream }) {
    this.callId = callId;
    this.localStream = localStream;
    this.remoteStream = remoteStream;
    this.recordingId = null;
    this.urls = new Map(); // chunk index → presigned PUT URL
    this.maxUrlIndex = -1;
    this.queue = []; // chunks waiting to upload: { index, blob }
    this.pendingBytes = 0;
    this.nextIndex = 0;
    this.uploadedBytes = 0;
    this.pumping = false;
    this.fetchingUrls = null;
  }

  async start() {
    try {
      if (typeof MediaRecorder === 'undefined') return debug('MediaRecorder not supported');
      const localVideo = this.localStream.getVideoTracks()[0];
      const mimeType = pickMimeType(!!localVideo);
      if (!mimeType) return debug('no supported recording format');

      // 1. Mix both voices into one audio track.
      this.audioCtx = new AudioContext();
      // Don't await: without a prior user click, resume() stays pending forever.
      // (In a real call the user clicked Call/Accept, so it resumes right away.)
      this.audioCtx.resume().catch(() => {});
      const mix = this.audioCtx.createMediaStreamDestination();
      for (const stream of [this.localStream, this.remoteStream]) {
        const tracks = stream?.getAudioTracks() ?? [];
        if (tracks.length) this.audioCtx.createMediaStreamSource(new MediaStream(tracks)).connect(mix);
      }
      // A suspended AudioContext makes MediaRecorder produce NO data at all. If it
      // can't start (no user click on the page yet), record our own mic instead.
      const running = await Promise.race([
        new Promise((resolve) => {
          if (this.audioCtx.state === 'running') resolve(true);
          this.audioCtx.onstatechange = () => this.audioCtx.state === 'running' && resolve(true);
        }),
        sleep(1000).then(() => false),
      ]);
      const tracks = running ? [...mix.stream.getAudioTracks()] : this.localStream.getAudioTracks().slice(0, 1);
      if (!running) debug('audio mixer suspended (no user click yet): recording own mic only');

      // 2. Our own video, as a separate low-resolution copy (the call keeps full quality).
      if (localVideo) {
        this.videoTrack = localVideo.clone();
        this.videoTrack.enabled = localVideo.enabled;
        await this.videoTrack
          .applyConstraints({ width: { max: 320 }, height: { max: 240 }, frameRate: { max: 15 }, resizeMode: 'crop-and-scale' })
          .catch((e) => debug('could not downscale', e));
        tracks.push(this.videoTrack);
      }

      // 3. Record in 10-second slices. Chunks queue up until upload URLs arrive.
      this.recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      this.recorder.ondataavailable = (e) => this.onChunk(e.data);
      this.stopped = new Promise((resolve) => (this.recorder.onstop = resolve));
      this.recorder.start(CHUNK_MS);
      this.startedAt = performance.now();

      // 4. Register with the backend and get the first batch of upload URLs.
      const res = await api('/recordings', { method: 'POST', body: { call_id: this.callId, mime_type: mimeType }, quiet: true });
      this.recordingId = res.recording_id;
      this.addUrls(res.upload_urls);
      debug('started', { mimeType, recordingId: this.recordingId });
      this.pump();
    } catch (e) {
      debug('recording disabled for this call:', e.message);
      this.abort();
    }
  }

  onChunk(blob) {
    if (!blob.size) return;
    const index = this.nextIndex++;
    if (this.pendingBytes + blob.size > MAX_PENDING_BYTES) return debug(`dropped chunk ${index}: upload backlog full`);
    this.queue.push({ index, blob });
    this.pendingBytes += blob.size;
    this.pump();
  }

  // Uploads chunks one at a time, in order. Re-entered on every new chunk.
  async pump() {
    if (this.pumping || !this.recordingId) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const { index, blob } = this.queue[0];
        const url = await this.urlFor(index);
        await this.put(url, blob);
        this.queue.shift();
        this.pendingBytes -= blob.size;
        this.uploadedBytes += blob.size;
        debug(`chunk ${index} uploaded (${(blob.size / 1024).toFixed(0)} KB)`);
      }
    } catch (e) {
      debug('upload paused, will retry with the next chunk:', e.message);
    } finally {
      this.pumping = false;
    }
  }

  async urlFor(index) {
    if (!this.urls.has(index + PREFETCH_WHEN_LEFT)) this.fetchMoreUrls(index); // background prefetch
    if (!this.urls.has(index)) await this.fetchMoreUrls(index);
    return this.urls.get(index);
  }

  fetchMoreUrls(fromIndex) {
    const start = Math.max(fromIndex, this.maxUrlIndex + 1);
    this.fetchingUrls ??= api(`/recordings/${this.recordingId}/urls?start=${start}`, { method: 'POST', quiet: true })
      .then((urls) => this.addUrls(urls))
      .finally(() => (this.fetchingUrls = null));
    return this.fetchingUrls;
  }

  addUrls(list) {
    for (const { index, url } of list) {
      this.urls.set(index, url);
      this.maxUrlIndex = Math.max(this.maxUrlIndex, index);
    }
  }

  async put(url, blob) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { method: 'PUT', body: blob });
        if (res.ok) return;
        throw new Error(`S3 responded ${res.status}`);
      } catch (e) {
        if (attempt >= 4) throw e;
        await sleep(1000 * 2 ** attempt); // 1, 2, 4, 8 s
      }
    }
  }

  // Keep the recording's camera in step with the user's camera button.
  setVideoEnabled(enabled) {
    if (this.videoTrack) this.videoTrack.enabled = enabled;
  }

  // Called when the call ends: flush the last chunk, finish uploads, report.
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.recorder?.state === 'recording') {
      this.recorder.stop(); // fires one last dataavailable, then onstop
      await this.stopped;
    }
    this.releaseDevices();
    if (!this.recordingId) return;

    const duration = (performance.now() - this.startedAt) / 1000;
    const deadline = Date.now() + 20_000;
    while ((this.queue.length || this.pumping) && Date.now() < deadline) {
      this.pump();
      await sleep(300);
    }
    await api(`/recordings/${this.recordingId}/complete`, {
      method: 'POST',
      quiet: true,
      body: { chunk_count: this.nextIndex, size_bytes: this.uploadedBytes, duration_seconds: duration },
    }).catch((e) => debug('complete failed:', e.message));
    debug('finished', { chunks: this.nextIndex, bytes: this.uploadedBytes, duration });
  }

  abort() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.releaseDevices();
  }

  releaseDevices() {
    this.videoTrack?.stop();
    this.audioCtx?.close().catch(() => {});
  }
}
