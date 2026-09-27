# Learn WebRTC → in-app call backend

| Step | Folder | What it teaches | How it becomes the real system |
|---|---|---|---|
| 1 | `step1_local/` | Offer/answer, ICE, peer connection states, all in one page | Fake `signal()` function stands in for the server |
| 2 | `step2_sdp/` | Reading SDP and ICE candidates line by line | Knowing what to debug in production |
| 3 | — | Python WebSocket signaling server, two tabs | Replaces `signal()` with a real server |
| 4 | — | Call protocol: users, ring / accept / decline / hangup, auth | Your app's call logic + state |
| 5 | — | STUN / TURN with coturn, testing across networks | Calls work on real mobile networks |
| 6 | — | Python as a peer with `aiortc` (optional) | Recording, bots, server-side processing |
| 7 | — | Mobile: push (VoIP push / FCM), CallKit / ConnectionService, reconnection, ICE restart | Calls ring on a locked phone and survive network changes |
| 8 | — | Group calls with an SFU (LiveKit / mediasoup) | Scaling beyond 1-to-1 |

## Run the browser steps

```bash
uv run python -m http.server 8000
# open http://localhost:8000/step1_local/ or /step2_sdp/
```
