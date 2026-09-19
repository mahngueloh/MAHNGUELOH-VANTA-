const $ = s => document.querySelector(s);

async function check() {
  try {
    const r = await fetch('/health');
    const j = await r.json();
    $('#status').textContent = j.status === 'healthy' ? 'Online' : 'Offline';
    if (j.version) $('#version').textContent = 'v' + j.version;
  } catch {
    $('#status').textContent = 'Offline';
  }
}

async function loadLimits() {
  try {
    const j = await (await fetch('/api/docs')).json();
    if (j.limits) $('#max').textContent = j.limits.max_file_mb + ' MB';
  } catch {}
}

async function download() {
  const out = $('#out');
  const key = $('#key').value.trim();
  const url = $('#url').value.trim();
  if (!key) { out.textContent = 'Enter your API key first.'; return; }
  if (!url) { out.textContent = 'Enter a file URL first.'; return; }
  out.textContent = 'Working…';
  try {
    const r = await fetch('/v1/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ url })
    });
    const j = await r.json();
    // textContent only: server data is never parsed as HTML.
    out.textContent = JSON.stringify(j, null, 2);
    if (j.download_url && /^https?:\/\//.test(j.download_url)) {
      out.appendChild(document.createTextNode('\n\nOpen: '));
      const a = document.createElement('a');
      a.href = j.download_url;
      a.textContent = j.download_url;
      a.target = '_blank';
      a.rel = 'noopener';
      out.appendChild(a);
    }
  } catch (e) {
    out.textContent = e.message;
  }
}

check();
loadLimits();
