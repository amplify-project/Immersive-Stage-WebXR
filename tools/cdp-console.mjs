// Headless Chrome over CDP: open a URL, print its console.log lines until one
// contains DONE (or the timeout). For pages whose results come after async work,
// which --dump-dom does not wait for.
//   SP=<scratch dir> node tools/cdp-console.mjs <url> [seconds]
// Open a URL in a headless Chrome over CDP and print console.log lines until "DONE" or timeout.
const [,, url, secs = '60'] = process.argv;
const { spawn } = await import('node:child_process');
const chrome = spawn('google-chrome', ['--headless=new', '--ignore-certificate-errors', '--remote-debugging-port=9333',
  '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + process.env.SP + '/cdp-profile', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) {
  try { const l = await (await fetch('http://127.0.0.1:9333/json/list')).json(); const p = l.find(x => x.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch {}
  await sleep(200);
}
await new Promise(r => ws.onopen = r);
let id = 0; const send = (m, p = {}) => ws.send(JSON.stringify({ id: ++id, method: m, params: p }));
const end = () => { try { chrome.kill(); } catch {} process.exit(0); };
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    const s = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
    console.log(s); if (s.includes('DONE')) end();
  }
  if (m.method === 'Runtime.exceptionThrown') console.log('EXC', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
send('Runtime.enable'); send('Page.navigate', { url });
setTimeout(() => { console.log('TIMEOUT'); end(); }, +secs * 1000);
