import { api, errorMessage } from '../api';
import type { Desktop } from '../shell/desktop';
import { loginRequired } from './session';

/** File > Log Off: close every window (each may ask about unsaved changes), then end the session. */
export async function logOff(desk: Desktop) {
  for (const w of [...desk.windows].sort((a, b) => b.z - a.z)) {
    desk.focus(w.id);
    if (!(await desk.requestClose(w.id))) return; // she chose to keep a window open
  }
  try {
    await api.post('/api/logout', {});
  } catch (e) {
    desk.setStatus(errorMessage(e));
    return;
  }
  desk.setStatus('');
  loginRequired();
}
