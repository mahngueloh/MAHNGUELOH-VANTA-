// Interactive API docs. All server data is inserted with textContent (never innerHTML).

function buildRequest(base, variant, values, key) {
  const query = new URLSearchParams();
  const body = {};
  for (const p of variant.params) {
    const v = (values[p.name] || '').trim();
    if (!v) continue;
    if (p.in === 'query') query.set(p.name, v);
    else if (p.in === 'body') body[p.name] = v;
  }
  if (variant.auth === 'query') query.set('apikey', key || 'YOUR_API_KEY');
  const qs = query.toString();
  const url = base + variant.path + (qs ? '?' + qs : '');
  const headers = {};
  if (variant.auth === 'bearer') headers.Authorization = 'Bearer ' + (key || 'YOUR_API_KEY');
  let payload = null;
  if (variant.method === 'POST') { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return { url, headers, payload };
}

function buildCurl(base, variant, values, key) {
  const r = buildRequest(base, variant, values, key);
  const parts = [`curl -X ${variant.method} "${r.url}"`];
  for (const [k, v] of Object.entries(r.headers)) parts.push(`-H "${k}: ${v}"`);
  if (r.payload !== null) parts.push(`-d '${r.payload.replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n  ');
}

if (typeof module !== 'undefined') module.exports = { buildRequest, buildCurl };

if (typeof document !== 'undefined') {
  const base = location.origin;
  const keyInput = document.getElementById('apikey');
  try { keyInput.value = sessionStorage.getItem('mh_key') || ''; } catch { /* storage blocked */ }
  keyInput.addEventListener('input', () => {
    try { sessionStorage.setItem('mh_key', keyInput.value.trim()); } catch {}
    document.querySelectorAll('.card.open').forEach(c => c._refresh && c._refresh());
  });

  const el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v);
    }
    for (const kid of [].concat(kids)) if (kid) n.append(kid);
    return n;
  };

  function renderCard(ep) {
    let current = ep.variants[0];
    const values = {};
    const card = el('div', { class: 'card' });
    const badge = el('span', { class: 'badge', text: current.method });
    const head = el('button', { class: 'head', 'aria-expanded': 'false', type: 'button' }, [
      badge, el('span', { class: 'title', text: ep.title }), el('span', { class: 'chev', text: '⌄' })
    ]);
    const pathLine = el('div', { class: 'path', text: current.path });
    const body = el('div', { class: 'body' });
    card.append(head, pathLine, body);

    const tabs = ep.variants.length > 1 ? el('div', { class: 'tabs', role: 'tablist' }) : null;
    const fields = el('div');
    const out = el('pre', { text: 'Press Execute to try it.' });
    const curl = el('pre');
    const key = () => keyInput.value.trim();

    const refresh = () => {
      curl.textContent = buildCurl(base, current, values, key());
      pathLine.textContent = current.path;
      badge.textContent = current.method;
      badge.className = 'badge' + (current.method === 'POST' ? ' post' : '');
    };
    card._refresh = refresh;

    const drawFields = () => {
      fields.replaceChildren();
      if (current.auth !== 'none') {
        fields.append(el('p', { class: 'hint muted' }, [el('span', { class: 'tag', text: 'key' }), ' Uses the API key from the top of the page.']));
      }
      for (const p of current.params) {
        const input = el('input', { type: 'text', id: `${ep.id}-${current.method}-${p.name}`, placeholder: p.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
        input.value = values[p.name] || '';
        input.addEventListener('input', () => { values[p.name] = input.value; refresh(); });
        fields.append(el('div', { class: 'field' }, [
          el('label', { for: input.id }, [p.name, p.required ? el('span', { class: 'req', text: ' *' }) : null]),
          el('span', { class: 'hint', text: p.label }),
          input
        ]));
      }
      refresh();
    };

    if (tabs) {
      for (const v of ep.variants) {
        const t = el('button', { type: 'button', role: 'tab', 'aria-selected': String(v === current), text: v.method });
        t.addEventListener('click', () => {
          current = v;
          tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b === t)));
          drawFields();
        });
        tabs.append(t);
      }
    }

    const run = el('button', { class: 'btn primary', type: 'button', text: 'Execute' });
    const clear = el('button', { class: 'btn', type: 'button', text: 'Clear' });
    const copy = el('button', { class: 'copy', type: 'button', text: 'Copy' });

    run.addEventListener('click', async () => {
      if (current.auth !== 'none' && !key()) { out.textContent = 'Enter your API key at the top of the page first.'; return; }
      const r = buildRequest(base, current, values, key());
      run.disabled = true; out.textContent = 'Working…';
      const t0 = performance.now();
      try {
        const res = await fetch(r.url, { method: current.method, headers: r.headers, body: r.payload });
        const raw = await res.text();
        let text = raw;
        try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* not JSON */ }
        out.replaceChildren(
          el('span', { class: 'status ' + (res.ok ? 'ok' : 'bad'), text: `STATUS: ${res.status}  (${Math.round(performance.now() - t0)} ms)` }),
          '\n\n' + text
        );
      } catch (e) { out.textContent = 'Request failed: ' + e.message; }
      finally { run.disabled = false; }
    });
    clear.addEventListener('click', () => {
      for (const k of Object.keys(values)) delete values[k];
      out.textContent = 'Press Execute to try it.';
      drawFields();
    });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(curl.textContent); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1200); }
      catch { copy.textContent = 'Press and hold to copy'; }
    });

    body.append(
      el('p', { class: 'desc', text: ep.description }),
      tabs, fields,
      el('div', { class: 'row' }, [run, clear]),
      el('div', { class: 'label', text: 'RESPONSE' }), out,
      el('div', { class: 'label' }, ['CURL COMMAND', copy]), curl
    );
    head.addEventListener('click', () => {
      const open = card.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
    });
    drawFields();
    return card;
  }

  fetch('/api/catalog').then(r => r.json()).then(cat => {
    const root = document.getElementById('catalog');
    root.replaceChildren();
    for (const group of cat) {
      root.append(el('h2', { class: 'cat', text: group.category }));
      for (const ep of group.endpoints) root.append(renderCard(ep));
    }
  }).catch(() => { document.getElementById('catalog').textContent = 'Could not load the endpoint list.'; });
}
