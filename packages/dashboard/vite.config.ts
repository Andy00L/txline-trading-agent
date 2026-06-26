import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static operator console for the TxLINE agent. It reads the read-only agent API over
// HTTP/SSE only (base URL from VITE_API_BASE_URL, default http://localhost:8080), so the
// dashboard stays decoupled from the runtime packages. sourceRef: docs/BUILD_PLAN.md (M7).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
