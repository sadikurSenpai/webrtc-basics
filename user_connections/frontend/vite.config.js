import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // '' = load ALL vars from .env, not only VITE_* ones (these stay server-side).
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.FRONTEND_PORT || 5173);

  const server = {
    port,
    strictPort: true,
    host: true, // listen on all interfaces (LAN + tunnel)
    // Vite rejects unknown Host headers; allow ngrok's public domains.
    allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.dev', '.ngrok.io'],
    proxy: {
      '/api': { target: env.BACKEND_URL || 'http://localhost:8000', changeOrigin: true },
      '/ws': { target: env.SIGNAL_SERVER_URL || 'http://localhost:8001', ws: true, changeOrigin: true },
    },
  };

  // `npm run preview` (built files) uses the same proxy + hosts.
  return { server, preview: server };
});
