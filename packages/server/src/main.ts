import { startServer, StartupError } from './server';
import { loadSettings } from './settings';

// Settings come from the environment (see packages/server/src/settings.ts and
// deploy/rapidbooks.env.example). Loopback by default; set HOST=0.0.0.0 (or the LAN
// address) when deploying, after setting a password.

try {
  await startServer(loadSettings(), { signals: true });
} catch (e) {
  console.error(e instanceof StartupError ? e.message : e);
  process.exit(1);
}
