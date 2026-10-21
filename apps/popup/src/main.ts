import { createApp } from 'vue';
import { App } from './app.ts';
import { report } from './ipc.ts';

// Release builds have no devtools: errors go to %LOCALAPPDATA%\refs\logs\popup.log.
window.addEventListener('error', (e) => report(`error: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => report(`unhandled: ${e.reason instanceof Error ? e.reason.stack : String(e.reason)}`));

const app = createApp(App);
app.config.errorHandler = (err) => report(`vue: ${err instanceof Error ? err.stack : String(err)}`);
app.mount('#app');
report('mounted');
