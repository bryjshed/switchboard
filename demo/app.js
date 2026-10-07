/* Switchboard showcase: presenter chrome and simulations. Algorithms come from sim.js (window.SB). */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, attrs = {}, html = '') => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (html) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- presenter chrome
  const sections = () => $$('main > section.band').filter((s) => !s.hidden);
  function buildNav() {
    const list = $('#sideList');
    list.innerHTML = '';
    sections().forEach((s, i) => {
      const li = el('li');
      li.append(el('a', { href: '#' + s.id }, `<span>${i === 0 ? '·' : String(i).padStart(2, '0')}</span>${esc(s.dataset.title)}`));
      list.append(li);
    });
  }
  function currentIndex() {
    const list = sections();
    const y = window.scrollY + 120;
    let idx = 0;
    list.forEach((s, i) => { if (s.offsetTop <= y) idx = i; });
    return idx;
  }
  function go(delta) {
    const list = sections();
    const i = Math.min(list.length - 1, Math.max(0, currentIndex() + delta));
    list[i].scrollIntoView({ block: 'start' });
  }
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ($('.lightbox')) { if (e.key === 'Escape') $('.lightbox').remove(); return; }
    if (e.key === 'Escape') { setMenu(false); return; }
    if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key) || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); go(1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key) || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { e.preventDefault(); sections()[0].scrollIntoView(); }
    else if (e.key === 'h') $('#howToggle').click();
  });
  function onScroll() {
    const s = sections()[currentIndex()];
    $$('#sideList a').forEach((a) => {
      const on = s && a.getAttribute('href') === '#' + s.id;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    });
  }
  addEventListener('scroll', onScroll, { passive: true });

  // the side menu becomes a drawer below laptop width
  function setMenu(open) {
    document.body.classList.toggle('nav-open', open);
    $('#menuBtn').setAttribute('aria-expanded', String(open));
    $('#menuBtn').textContent = open ? 'Close' : 'Menu';
  }
  $('#menuBtn').addEventListener('click', () => setMenu(!document.body.classList.contains('nav-open')));
  $('#sideList').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });

  // "Technical details": show or hide the explanation panel at the end of every section
  const howBtn = $('#howToggle');
  function setHow(on) {
    document.body.classList.toggle('hide-how', !on);
    howBtn.setAttribute('aria-checked', String(on));
    store.set('sb-demo-how', on ? '1' : '0');
  }
  howBtn.addEventListener('click', () => setHow(howBtn.getAttribute('aria-checked') !== 'true'));
  setHow(store.get('sb-demo-how') !== '0');

  // zoom a screenshot
  document.addEventListener('click', (e) => {
    const img = e.target.closest('[data-zoom] img');
    if (!img) return;
    const box = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Screenshot, click to close' });
    box.append(el('img', { src: img.currentSrc || img.src, alt: img.alt }));
    box.addEventListener('click', () => box.remove());
    document.body.append(box);
  });

  // ---------------------------------------------------------------- 01 first run
  (function setup() {
    const names = ['Priya', 'Marco', 'Dana', 'Tomás', 'Aiko', 'Sam'];
    let people = [];
    let invitedNext = false;
    let orgs = 0;
    const out = $('#setupPeople');
    const mode = () => $('input[name="orgmode"]:checked').value;
    function render() {
      out.innerHTML = '';
      if (!people.length) out.append(el('p', { class: 'note' }, 'Nobody has signed in yet. Press <b>Next person signs in</b>.'));
      for (const p of people) {
        const row = el('div', { class: 'person' });
        row.append(el('div', { class: 'av' }, esc(p.name.slice(0, 2))));
        row.append(el('div', {}, `<b>${esc(p.name)}</b> <span class="pill plain ${p.cls}">${esc(p.badge)}</span><div class="sees">${esc(p.sees)}</div>`));
        out.append(row);
      }
      $('#setupInvite').textContent = invitedNext ? 'Invitation sent ✓' : 'Admin invites the next person';
      $('#setupInvite').disabled = invitedNext || orgs === 0 || people.length >= names.length;
      $('#setupNext').disabled = people.length >= names.length;
    }
    $('#setupNext').addEventListener('click', () => {
      const name = names[people.length];
      if (invitedNext) {
        people.push({ name, badge: 'joined by invitation', cls: 'ok', sees: 'Lands straight in Acme Mobile as a member (verified email).' });
        invitedNext = false;
      } else if (mode() === 'open' || orgs === 0) {
        orgs++;
        people.push({ name, badge: 'owner', cls: 'ai', sees: orgs === 1 ? '"Create your organization" → Acme Mobile. They own it.' : `"Create your organization" → their own separate org (#${orgs}).` });
      } else {
        people.push({ name, badge: 'needs an invitation', cls: 'warn', sees: '"You need an invitation." POST /api/orgs would return 403.' });
      }
      render();
    });
    $('#setupInvite').addEventListener('click', () => { invitedNext = true; render(); });
    const reset = () => { people = []; invitedNext = false; orgs = 0; render(); };
    $('#setupReset').addEventListener('click', reset);
    $$('input[name="orgmode"]').forEach((r) => r.addEventListener('change', reset));
    render();
  })();

  // ---------------------------------------------------------------- 02 evaluation ladder
  (function ladder() {
    const T = 'v-true', F = 'v-false';
    const segments = {
      'beta-testers': {
        key: 'beta-testers', includedKeys: ['user-alice', 'user-101', 'user-102'], excludedKeys: [],
        rules: [{ clauses: [{ attribute: 'betaOptIn', op: 'EQUALS', values: ['true'] }] }],
      },
    };
    const steps = [
      ['kill', 'Kill switch on?'],
      ['enabled', 'Flag switched off?'],
      ['targets', 'Individual target for this user?'],
      ['rules', 'Rule 1: in segment beta-testers · Rule 2: plan = pro'],
      ['fallthrough', 'Fallthrough: everyone else gets false'],
    ];
    function run() {
      const flag = {
        key: 'pro-plan-features', enabled: $('#ldOn').checked, killSwitchActive: $('#ldKill').checked,
        variations: [{ id: T, value: 'true' }, { id: F, value: 'false' }],
        targeting: {
          individualTargets: $('#ldTarget').checked ? [{ contextKey: 'user-42', variationId: F }] : [],
          rules: [
            { id: 'r1', clauses: [{ attribute: 'key', op: 'SEGMENT_MATCH', values: ['beta-testers'] }], serve: { variationId: T } },
            { id: 'r2', clauses: [{ attribute: 'plan', op: 'EQUALS', values: ['pro'] }], serve: { variationId: T } },
          ],
          fallthrough: { variationId: F }, offVariationId: F, defaultVariationId: T,
        },
      };
      const ctx = { key: $('#ldUser').value, attributes: { plan: $('#ldPlan').value } };
      if ($('#ldBeta').checked) ctx.attributes.betaOptIn = true;
      const r = SB.evaluate(flag, ctx, segments);
      const ol = $('#ldLadder');
      ol.innerHTML = '';
      const decidedAt = steps.findIndex(([k]) => k === r.step);
      steps.forEach(([, label], i) => {
        const cls = i < decidedAt ? 'miss' : i === decidedAt ? 'hit' : 'skip';
        const res = i === decidedAt ? `decides → ${r.reason}${r.ruleIndex !== undefined ? ' (rule ' + (r.ruleIndex + 1) + ')' : ''}` : '';
        ol.append(el('li', { class: cls }, `<span class="n">${i + 1}</span><span>${esc(label)}</span><span class="res">${esc(res)}</span>`));
      });
      const val = r.variationId === T ? 'true' : 'false';
      $('#ldResult').innerHTML = `<span>${esc(ctx.key)} gets</span> <span class="val ${val === 'true' ? 'on' : 'off'}">${val}</span> <span class="pill plain">${esc(r.reason)}</span>`;
    }
    $$('#sim-ladder select, #sim-ladder input').forEach((i) => i.addEventListener('change', run));
    run();
  })();

  // ---------------------------------------------------------------- 03 rollout dots
  (function rollout() {
    const N = 200;
    const grid = $('#roDots');
    const dots = [];
    for (let i = 1; i <= N; i++) {
      const d = el('div', { class: 'dot', 'data-user': 'user-' + i });
      grid.append(d);
      dots.push(d);
    }
    let prev = null;
    let buckets = [];
    const computeBuckets = () => { buckets = dots.map((d) => SB.bucket($('#roFlag').value, d.dataset.user)); };
    const countNew = (pct, from) => buckets.filter((b) => b < pct * 100 && b >= from * 100).length;
    function render(pct, fromPrev) {
      let n = 0;
      dots.forEach((d, i) => {
        const inNow = buckets[i] < pct * 100;
        const wasIn = fromPrev !== null && buckets[i] < fromPrev * 100;
        d.classList.toggle('in', inNow);
        d.classList.toggle('new', fromPrev !== null && inNow && !wasIn);
        d.classList.toggle('gone', fromPrev !== null && !inNow && wasIn);
        if (inNow) n++;
      });
      const change = fromPrev === null ? '' : pct > fromPrev ? ` · widened: nobody left, ${countNew(pct, fromPrev)} added` : pct < fromPrev ? ' · narrowed' : '';
      $('#roOut').innerHTML = `<b>${pct}%</b> → ${n} of ${N} users${change}`;
    }
    let settleTimer = null;
    $('#roPct').addEventListener('input', (e) => {
      const pct = +e.target.value;
      if (prev === null) prev = pct;
      render(pct, prev);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { prev = pct; }, 1400);
    });
    $('#roFlag').addEventListener('change', () => { computeBuckets(); prev = null; render(+$('#roPct').value, null); });
    grid.addEventListener('mouseover', (e) => {
      const d = e.target.closest('.dot');
      if (!d) return;
      const i = dots.indexOf(d);
      $('#roHover').innerHTML = `<code>${esc(d.dataset.user)}</code> is in bucket <b class="mono">${buckets[i]}</b> of 10,000 for <code>${esc($('#roFlag').value)}</code>, so it gets the new variation from <b>${Math.floor(buckets[i] / 100) + 1}%</b> upward.`;
    });
    computeBuckets();
    render(10, null);
  })();

  // ---------------------------------------------------------------- 04 versions
  (function versions() {
    const initial = [
      { v: 1, note: 'flag created', who: 'alice', state: 'off', cfg: 'off' },
      { v: 2, note: 'initial ramp 10%', who: 'alice', state: 'on', cfg: '10%' },
      { v: 3, note: 'rollback to v1 · checkout error spike', who: 'alice', state: 'off', cfg: 'off' },
      { v: 4, note: 'retry ramp at 25% after fix', who: 'alice', state: 'on', cfg: '25%' },
    ];
    let list, killed, fresh;
    const head = () => list[list.length - 1];
    function banner(html, cls = 'info') { $('#vBanner').innerHTML = html ? `<div class="banner ${cls}">${html}</div>` : ''; }
    function render() {
      const ul = $('#vList');
      ul.innerHTML = '';
      [...list].reverse().forEach((x, i) => {
        const li = el('li', { class: (i === 0 ? 'live ' : '') + (x.v === fresh ? 'fresh' : '') });
        li.innerHTML = `<span class="v">v${x.v}</span><span>${esc(x.note)} <span class="who">· ${esc(x.who)}</span></span>` +
          `<span class="pill ${x.state === 'killed' ? 'bad' : x.state === 'on' ? 'ok' : 'plain'}">${i === 0 ? 'live · ' : ''}${esc(x.state === 'on' ? x.cfg : x.state)}</span>`;
        ul.append(li);
      });
    }
    function push(entry) { list.push({ v: head().v + 1, ...entry }); fresh = head().v; render(); }
    $('#vRamp').addEventListener('click', () => {
      push({ note: 'ramp to 50%', who: 'alice', state: killed ? 'killed' : 'on', cfg: '50%' });
      banner(`Saved as <b>v${head().v}</b> with <code>expectedVersion: ${head().v - 1}</code>. Snapshot, audit row and a <code>patch</code> to every SDK.`, 'ok');
    });
    $('#vRollback').addEventListener('click', () => {
      push({ note: 'rollback to v2', who: 'alice', state: killed ? 'killed' : 'on', cfg: '10%' });
      banner(`Rolled back by writing <b>v${head().v}</b> with v2's config. Earlier versions are all still there, and this rollback can itself be rolled back.`, 'ok');
    });
    $('#vKill').addEventListener('click', () => {
      killed = !killed;
      push({ note: killed ? 'kill switch on · declines spiking' : 'kill switch off', who: 'alice', state: killed ? 'killed' : 'on', cfg: head().cfg === 'off' ? '25%' : head().cfg });
      $('#vKill').textContent = killed ? 'Release kill switch' : 'Pull kill switch';
      banner(killed ? 'Everyone now gets the off variation. Targeting is untouched, so releasing it restores the rollout exactly.' : 'Released. The rollout is back as it was.', killed ? 'bad' : 'ok');
    });
    $('#vStale').addEventListener('click', () => {
      banner(`<b>409 Conflict.</b> A tab that loaded v${head().v - 1} tried to save with <code>expectedVersion: ${head().v - 1}</code>, but the flag is at v${head().v}. Nothing was overwritten; reload and reapply.`, 'bad');
    });
    list = initial.map((x) => ({ ...x })); killed = false; fresh = null; banner(''); render();
  })();

  // ---------------------------------------------------------------- 05 streaming
  (function stream() {
    const log = $('#stLog');
    const pkt = $('#pkt');
    let state = 7;
    let busy = false;
    const ts = () => new Date().toISOString().slice(11, 19);
    function line(html) { log.append(el('div', {}, html)); log.scrollTop = log.scrollHeight; }
    function connectFrames() {
      log.innerHTML = '';
      ['Java · checkout', 'Node · api', 'Java · worker'].forEach((s) => {
        line(`<span class="t">${ts()}</span> ${esc(s)} ← <span class="e">event: put</span> <span class="t">id: ${state}</span>  data: {"flags":[…10 flags…],"segments":[…]}`);
      });
    }
    function lit(ids) { ids.forEach((id) => { const n = document.getElementById(id); if (n) n.classList.add('lit'); }); }
    async function travel(pathId, ms) {
      const p = document.getElementById(pathId);
      const len = p.getTotalLength();
      if (reducedMotion()) return;
      const t0 = performance.now();
      return new Promise((res) => {
        function frame(now) {
          const k = Math.min(1, (now - t0) / ms);
          const pt = p.getPointAtLength(len * k);
          pkt.setAttribute('cx', pt.x); pkt.setAttribute('cy', pt.y);
          if (k < 1) requestAnimationFrame(frame); else res();
        }
        requestAnimationFrame(frame);
      });
    }
    $('#stKill').addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      $('#stKill').disabled = true;
      $$('#stSvg .lit').forEach((n) => n.classList.remove('lit'));
      lit(['nDash']);
      line(`<span class="t">${ts()}</span> POST …/payment-provider-v3/environments/production/kill-switch {"active":true}`);
      await travel('w1', 600); lit(['w1', 'nA']);
      line(`<span class="t">${ts()}</span> backend A: version written, audit row, COMMIT, then pg_notify('flag_change', …)`);
      state++;
      await travel('w2', 500); lit(['w2', 'nPg']);
      await travel('w3', 500); lit(['w3', 'nB']);
      line(`<span class="t">${ts()}</span> backend B: NOTIFY received, evicted cached payload for production`);
      await travel('w4a', 200); lit(['w4a']);
      for (const [w, n, who] of [['w5a', 'nS1', 'Java · checkout'], ['w5b', 'nS2', 'Node · api'], ['w5c', 'nS3', 'Java · worker']]) {
        await travel(w, 260); lit([w, n]);
        line(`<span class="t">${ts()}</span> ${who} ← <span class="e">event: patch</span> <span class="t">id: ${state}</span>  data: {"flagKey":"payment-provider-v3","enabled":true,"killSwitchActive":true,"version":4,"stateVersion":${state}}`);
      }
      pkt.setAttribute('cx', -20);
      line(`<span class="t">${ts()}</span> every SDK now serves <b>false</b> for payment-provider-v3, locally, with reason KILL_SWITCH`);
      busy = false;
    });
    $('#stReset').addEventListener('click', () => { $$('#stSvg .lit').forEach((n) => n.classList.remove('lit')); $('#stKill').disabled = false; connectFrames(); });
    connectFrames();
    setInterval(() => { if (!busy && document.visibilityState === 'visible') line(`<span class="t">${ts()}</span> <span class="e">event: ping</span> <span class="t">(keeps proxies from closing the stream)</span>`); }, 15000);
  })();

  // ---------------------------------------------------------------- 06 SDK tabs + vectors
  (function sdks() {
    const snippets = {
      Java: `<span class="c">// build once from source: ./mvnw -pl evaluation,sdk/java -am install</span>
<span class="k">var</span> switchboard = <span class="k">new</span> SwitchboardClient(
    SwitchboardConfig.builder(System.getenv(<span class="s">"SWITCHBOARD_SDK_KEY"</span>))
        .baseUri(<span class="s">"https://switchboard.example.com"</span>)
        .build());
switchboard.start();          <span class="c">// bootstrap once, then stream changes</span>

<span class="k">boolean</span> on = switchboard.booleanValue(<span class="s">"new-checkout"</span>, <span class="k">false</span>,
    EvalContexts.builder(userId).put(<span class="s">"plan"</span>, <span class="s">"pro"</span>).build()).value();

switchboard.track(<span class="s">"conversion"</span>, userId);   <span class="c">// feeds heal / optimize</span>`,
      Node: `<span class="k">import</span> { SwitchboardClient } <span class="k">from</span> <span class="s">'@switchboard/openfeature-provider/core'</span>;

<span class="k">const</span> switchboard = <span class="k">new</span> SwitchboardClient({
  sdkKey: process.env.SWITCHBOARD_SDK_KEY,
  baseUrl: <span class="s">'https://switchboard.example.com'</span>,
});
<span class="k">await</span> switchboard.start();

<span class="k">const</span> on = switchboard.booleanValue(<span class="s">'new-checkout'</span>,
  { key: userId, attributes: { plan: <span class="s">'pro'</span> } }, <span class="k">false</span>);

switchboard.track(<span class="s">'error'</span>, userId);`,
      REST: `curl -X POST https://switchboard.example.com/api/eval/new-checkout \\
  -H <span class="s">"Authorization: Bearer $SWITCHBOARD_SDK_KEY"</span> \\
  -H <span class="s">'Content-Type: application/json'</span> \\
  -d <span class="s">'{"context":{"key":"user-42","attributes":{"plan":"pro"}},"default":"false"}'</span>

<span class="c"># {"value":"true","reason":"ROLLOUT","variationId":"…"}</span>
<span class="c"># an unknown flag returns your default, at HTTP 200</span>`,
      OpenFeature: `<span class="c">// Any OpenFeature SDK with an OFREP provider: Go, Python, .NET, Java, JS</span>
<span class="k">import</span> { OpenFeature } <span class="k">from</span> <span class="s">'@openfeature/server-sdk'</span>;
<span class="k">import</span> { OFREPProvider } <span class="k">from</span> <span class="s">'@openfeature/ofrep-provider'</span>;

<span class="k">await</span> OpenFeature.setProviderAndWait(<span class="k">new</span> OFREPProvider({
  baseUrl: <span class="s">'https://switchboard.example.com'</span>,
  headers: [[<span class="s">'Authorization'</span>, <span class="s">\`Bearer \${process.env.SWITCHBOARD_SDK_KEY}\`</span>]],
}));
<span class="k">const</span> on = <span class="k">await</span> OpenFeature.getClient()
  .getBooleanValue(<span class="s">'new-checkout'</span>, <span class="k">false</span>, { targetingKey: userId });`,
    };
    const tabs = $('#sdkTabs');
    Object.keys(snippets).forEach((name, i) => {
      const b = el('button', { role: 'tab', 'aria-selected': String(i === 0), type: 'button' }, name);
      b.addEventListener('click', () => {
        $$('button', tabs).forEach((x) => x.setAttribute('aria-selected', 'false'));
        b.setAttribute('aria-selected', 'true');
        $('#sdkCode').innerHTML = snippets[name];
      });
      tabs.append(b);
    });
    $('#sdkCode').innerHTML = snippets.Java;

    const vec = [['operators', 306], ['ramp-at-10', 40], ['ramp-at-25', 40], ['stickiness', 24], ['bucket', 22], ['clauses', 21], ['precedence-boolean', 18], ['precedence-multivariate', 13], ['segments', 12], ['rollout-weights', 11]];
    const max = vec[0][1];
    const bars = $('#vecBars');
    vec.forEach(([name, n]) => {
      const row = el('div', { class: 'row' });
      row.innerHTML = `<span class="mono" style="font-size:12.5px">${name}</span><span class="track"><span class="fill" style="width:${(n / max) * 100}%;background:var(--accent)"></span></span><span class="num">${n}</span>`;
      bars.append(row);
    });
  })();

  // ---------------------------------------------------------------- chart helper (log-scale e-value)
  function eChart(host, { hours, threshold, thresholdLabel }) {
    const W = 640, H = 240, L = 48, R = 16, T = 14, B = 30;
    const yMin = Math.log(0.1), yMax = Math.log(10000);
    const x = (h) => L + (h / hours) * (W - L - R);
    const y = (lnE) => T + (1 - (Math.max(yMin, Math.min(yMax, lnE)) - yMin) / (yMax - yMin)) * (H - T - B);
    const ticks = [0.1, 1, 10, 100, 1000, 10000];
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evidence (e-value, log scale) over hours. Shaded: too few users to judge yet.">
      <rect class="gate" x="${L}" y="${T}" width="0" height="${H - T - B}" data-gate/>
      <g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(Math.log(t))}" y2="${y(Math.log(t))}"/>`).join('')}</g>
      <g class="axis">${ticks.map((t) => `<text x="${L - 6}" y="${y(Math.log(t)) + 4}" text-anchor="end">${t >= 1 ? t.toLocaleString() : t}</text>`).join('')}
        ${[0, 12, 24, 36, 48].filter((h) => h <= hours).map((h) => `<text x="${x(h)}" y="${H - 8}" text-anchor="middle">${h}h</text>`).join('')}</g>
      <line class="thr" x1="${L}" x2="${W - R}" y1="${y(Math.log(threshold))}" y2="${y(Math.log(threshold))}"/>
      <text class="thr-lbl" x="${W - R}" y="${y(Math.log(threshold)) - 6}" text-anchor="end">${thresholdLabel}</text>
      <polyline class="series" points=""/>
      <circle class="mark" r="6" cx="-20" cy="-20"/>
    </svg>`;
    const s = host.querySelector('svg');
    let gateUntil = 0;
    return {
      setGate(h) { gateUntil = h; },
      draw(points, hitAt, good) {
        s.querySelector('.series').setAttribute('points', points.map(([h, v]) => `${x(h)},${y(v)}`).join(' '));
        s.querySelector('[data-gate]').setAttribute('width', Math.max(0, x(Math.min(gateUntil, hours)) - L));
        const m = s.querySelector('.mark');
        m.classList.toggle('good', !!good);
        if (hitAt) { m.setAttribute('cx', x(hitAt[0])); m.setAttribute('cy', y(hitAt[1])); } else { m.setAttribute('cx', -20); m.setAttribute('cy', -20); }
      },
    };
  }

  // ---------------------------------------------------------------- 07 metrics & tracking
  // Each request: a new user is bucketed for payment-provider-v3 at 50/50 (real bucketing), the SDK
  // records the exposure, and the charge fails with the variant's error rate -> track("error").
  // The join counts distinct users per variation and feeds the real e-value (tau 0.01, heal alpha 0.05).
  (function metrics() {
    const FLAG = 'payment-provider-v3', TAU = 0.01, ALPHA = 0.05, MIN_SUBJ = 200, V2_RATE = 0.02, NOISE = 0.05;
    const VAR_ID = { true: '4f1c…e2a0', false: '9b7d…13c5' };
    const feeds = { req: $('#mtReq'), ev: $('#mtEval'), mt: $('#mtMetric') };
    let rng, n, users, errs, timer;
    const rateEl = $('#mtRate');
    rateEl.addEventListener('input', () => { $('#mtRateOut').textContent = rateEl.value + '%'; });
    function push(feed, html) {
      feed.append(el('div', {}, html));
      while (feed.childElementCount > 7) feed.firstElementChild.remove();
    }
    function render() {
      const row = (v, label) => {
        const r = users[v] ? errs[v] / users[v] : 0;
        return `<tr><td><code>${v}</code> · ${label}</td><td>${users[v].toLocaleString()}</td><td>${errs[v].toLocaleString()}</td><td class="${v === 'true' && users.true >= 50 && r > 2 * V2_RATE ? 'bad' : ''}">${users[v] ? (100 * r).toFixed(1) + '%' : '—'}</td></tr>`;
      };
      $('#mtJoin').innerHTML = `<thead><tr><th>Variation</th><th>Users exposed</th><th>Users with an error</th><th>Error rate</th></tr></thead><tbody>${row('true', 'new provider')}${row('false', 'current provider')}</tbody>`;
      const lnE = SB.logEValueOneSided(errs.true, users.true, errs.false, users.false, TAU);
      const E = Math.exp(lnE);
      const ready = users.true >= MIN_SUBJ && users.false >= MIN_SUBJ;
      const fire = ready && lnE >= SB.logThreshold(ALPHA);
      const pct = Math.min(100, (Math.max(0, lnE) / SB.logThreshold(ALPHA)) * 100);
      const v = $('#mtVerdict');
      v.classList.toggle('fire', fire);
      v.innerHTML = `<div>Evidence that <code>true</code> errors more: <span class="e">E = ${E < 1000 ? E.toFixed(E < 10 ? 2 : 1) : Math.round(E).toLocaleString()}</span> <span class="note">· rolls back at 20</span></div>
        <div class="meter"><i style="width:${pct}%"></i></div>
        <div>${fire ? '<b>The monitor rolls this back at its next scan.</b> v3 is worse, and the evidence is strong enough to act on.'
          : !ready ? `Waiting for 200 users on each variation before judging (${Math.min(users.true, users.false)} so far).`
          : 'Not enough evidence yet. Every request adds to it, and checking often costs nothing.'}</div>`;
      if (fire) stop();
    }
    function one() {
      n++;
      const key = 'user-' + (1000 + n);
      const b = SB.bucket(FLAG, key);
      const v = b < 5000 ? 'true' : 'false';
      const ts = new Date(Date.now()).toISOString().slice(11, 19);
      users[v]++;
      const p = v === 'true' ? +rateEl.value / 100 : V2_RATE;
      const flagErr = rng() < p;
      const noiseErr = $('#mtNoise').checked && rng() < NOISE;
      const errored = flagErr || noiseErr;
      if (errored) errs[v]++;
      push(feeds.req, `<span class="t">${ts}</span> ${key} → <span class="k">${v === 'true' ? 'v3' : 'v2'}</span> <span class="t">(bucket ${b})</span> ${errored ? `<span class="x">${flagErr ? 'charge failed' : 'unrelated error'} → track("error")</span>` : '<span class="s">ok</span>'}`);
      push(feeds.ev, `{<span class="k">"flagKey"</span>:<span class="s">"${FLAG}"</span>,<span class="k">"contextKey"</span>:<span class="s">"${key}"</span>,<span class="k">"variationId"</span>:<span class="s">"${VAR_ID[v]}"</span>,<span class="k">"reason"</span>:<span class="s">"ROLLOUT"</span>}`);
      if (errored) push(feeds.mt, `{<span class="k">"contextKey"</span>:<span class="s">"${key}"</span>,<span class="k">"metricKey"</span>:<span class="s">"error"</span>,<span class="k">"value"</span>:1}`);
      render();
    }
    function stop() { clearInterval(timer); timer = null; $('#mtPlay').textContent = 'Send traffic'; }
    function reset() {
      stop(); rng = SB.rng(42); n = 0; users = { true: 0, false: 0 }; errs = { true: 0, false: 0 };
      Object.values(feeds).forEach((f) => { f.innerHTML = ''; });
      push(feeds.mt, '<span class="t">// only requests that call track() appear here</span>');
      render();
    }
    $('#mtPlay').addEventListener('click', () => {
      if (timer) { stop(); return; }
      $('#mtPlay').textContent = 'Pause';
      timer = setInterval(() => { for (let i = 0; i < 4; i++) { if (!timer) break; one(); } }, reducedMotion() ? 0 : 60);
    });
    $('#mtOne').addEventListener('click', () => { stop(); one(); });
    $('#mtReset').addEventListener('click', reset);
    $('#mtNoise').addEventListener('change', reset);
    reset();
  })();

  // ---------------------------------------------------------------- 08 heal
  (function heal() {
    const BASE = 0.02, TAU = 0.01, ALPHA = 0.05, MIN_SUBJ = 200, HOURS = 48;
    const chart = eChart($('#hlChart'), { hours: HOURS, threshold: 1 / ALPHA, thresholdLabel: 'roll back at E ≥ 20 (α = 0.05)' });
    const rateEl = $('#hlRate'), nEl = $('#hlN');
    const upd = () => { $('#hlRateOut').textContent = rateEl.value + '%'; $('#hlNOut').textContent = nEl.value; };
    rateEl.addEventListener('input', upd); nEl.addEventListener('input', upd); upd();
    let timer = null, seed = 7;
    function stats(h, x1, n1, x2, n2, e) {
      $('#hlStats').innerHTML = [
        ['hour', h], ['new variant', `${x1}/${n1}`], ['baseline', `${x2}/${n2}`], ['evidence E', e < 1000 ? e.toFixed(e < 10 ? 2 : 1) : Math.round(e).toLocaleString()],
      ].map(([k, v], i) => `<div class="stat"><div class="k">${k}</div><div class="v ${i === 3 && e >= 1 / ALPHA ? 'bad' : ''}">${v}</div></div>`).join('');
    }
    function run() {
      clearInterval(timer);
      const rng = SB.rng(seed++);
      const pNew = +rateEl.value / 100, perHour = +nEl.value;
      let x1 = 0, n1 = 0, x2 = 0, n2 = 0, h = 0, gate = null;
      const pts = [[0, 0]];
      $('#hlOutcome').innerHTML = '';
      chart.setGate(0);
      chart.draw(pts, null);
      $('#hlRun').disabled = true;
      const step = () => {
        h++;
        for (let i = 0; i < perHour; i++) { n1++; if (rng() < pNew) x1++; n2++; if (rng() < BASE) x2++; }
        const lnE = SB.logEValueOneSided(x1, n1, x2, n2, TAU);
        if (gate === null && n1 >= MIN_SUBJ && n2 >= MIN_SUBJ) gate = h;
        chart.setGate(gate === null ? h : gate - 1);
        pts.push([h, lnE]);
        const hit = gate !== null && lnE >= SB.logThreshold(ALPHA);
        chart.draw(pts, hit ? [h, lnE] : null);
        stats(h, x1, n1, x2, n2, Math.exp(lnE));
        if (hit) {
          $('#hlOutcome').innerHTML = `<div class="banner bad"><b>Hour ${h}: rolled back.</b> The new variant errors at ${(100 * x1 / n1).toFixed(1)}% vs ${(100 * x2 / n2).toFixed(1)}% with E = ${Math.exp(lnE).toFixed(1)} ≥ 20. The monitor writes a new version serving the baseline, authored by <code>switchboard-monitor</code>, marked as an AI change in Activity, and sends a <code>flag.rollback</code> webhook.</div>`;
          return true;
        }
        if (h >= HOURS) {
          $('#hlOutcome').innerHTML = `<div class="banner info"><b>48 hours, no rollback.</b> ${n1 < MIN_SUBJ ? 'Not enough users yet to judge (200 per variant).' : 'The evidence never reached 20, so the monitor leaves the rollout alone. Try a higher error rate or more traffic.'}</div>`;
          return true;
        }
        return false;
      };
      if (reducedMotion()) { while (!step()); $('#hlRun').disabled = false; return; }
      timer = setInterval(() => { if (step()) { clearInterval(timer); $('#hlRun').disabled = false; } }, 140);
    }
    $('#hlRun').addEventListener('click', run);
    stats(0, 0, 0, 0, 0, 1);
    chart.draw([[0, 0]], null);
  })();

  // ---------------------------------------------------------------- 07b A/A peeking
  (function peek() {
    const rows = [['p < 0.05, checked hourly', 'naive'], ['Switchboard (α = 0.05)', 'mix']];
    const host = $('#pkBars');
    const SCALE = 0.4; // bars span 0–40%
    function draw(values) {
      host.innerHTML = '';
      rows.forEach(([label, kind], i) => {
        const v = values ? values[i] : null;
        const w = v === null ? 0 : Math.min(100, (v / SCALE) * 100);
        const row = el('div', { class: 'row' });
        row.innerHTML = `<span>${esc(label)}</span><span class="track"><span class="fill ${kind === 'mix' ? 'ok' : 'bad'}" style="width:${w}%"></span><span class="alpha" style="left:${(0.05 / SCALE) * 100}%" title="5%"></span></span><span class="num">${v === null ? '—' : (v * 100).toFixed(1) + '%'}</span>`;
        host.append(row);
      });
    }
    $('#pkRun').addEventListener('click', () => {
      $('#pkRun').disabled = true;
      $('#pkOut').textContent = 'simulating 48,000 hourly checks…';
      setTimeout(() => {
        const r = SB.peekingRates({ trials: 1000, peeks: 48, perPeek: 100, baseRate: 0.05, alpha: 0.05, tau: 0.01, z: 1.645, seed: 20260824 });
        draw([r.naive, r.mixture]);
        $('#pkOut').innerHTML = `false rollbacks: <b>${Math.round(r.naive * 1000)}</b> vs <b>${Math.round(r.mixture * 1000)}</b> of 1,000`;
        $('#pkRun').disabled = false;
      }, 30);
    });
    draw(null);
  })();

  // ---------------------------------------------------------------- 08 optimize
  (function optimize() {
    const LADDER = [25, 50, 75, 100], TAU = 0.02, ALPHA = 0.01, MIN_SUBJ = 200, PER_HOUR = 400, BASE = 0.18, NEW = 0.30, HOURS = 48;
    const chart = eChart($('#opChart'), { hours: HOURS, threshold: 1 / ALPHA, thresholdLabel: 'ramp at E ≥ 100 (α = 0.01)' });
    let rung, timer, seed;
    function renderRamp() { $$('#opRamp div').forEach((d, i) => { d.className = i < rung ? 'done' : i === rung ? 'now' : ''; }); }
    function reset() {
      clearInterval(timer); rung = 0; seed = 11;
      $('#opProps').innerHTML = ''; renderRamp(); chart.setGate(0); chart.draw([[0, 0]], null); $('#opRun').disabled = false;
    }
    function advance() { rung = Math.min(LADDER.length - 1, rung + 1); renderRamp(); if (rung < LADDER.length - 1) $('#opRun').disabled = false; }
    function addProp(from, to, auto) {
      const li = el('li');
      li.innerHTML = `<span class="pill ai">Update flag</span><span class="pill ${auto ? 'ok' : 'plain'}">${auto ? 'applied' : 'draft · awaiting review'}</span><span>new-checkout: ramp ${from}% → ${to}%</span>`;
      if (!auto) {
        const b = el('button', { class: 'btn', type: 'button' }, 'Apply');
        b.addEventListener('click', () => { b.remove(); li.querySelector('.pill.plain').outerHTML = '<span class="pill ok">applied by alice</span>'; advance(); });
        li.append(b);
      }
      $('#opProps').prepend(li);
    }
    function run() {
      clearInterval(timer);
      $('#opRun').disabled = true;
      const rng = SB.rng(seed++);
      const share = LADDER[rung] / 100;
      let x1 = 0, n1 = 0, x2 = 0, n2 = 0, h = 0, gate = null;
      const pts = [[0, 0]];
      chart.setGate(0);
      const step = () => {
        h++;
        for (let i = 0; i < PER_HOUR; i++) {
          if (rng() < share) { n1++; if (rng() < NEW) x1++; } else { n2++; if (rng() < BASE) x2++; }
        }
        const lnE = SB.logEValueOneSided(x1, n1, x2, n2, TAU);
        if (gate === null && n1 >= MIN_SUBJ && n2 >= MIN_SUBJ) gate = h;
        chart.setGate(gate === null ? h : gate - 1);
        pts.push([h, lnE]);
        const hit = gate !== null && lnE >= SB.logThreshold(ALPHA);
        chart.draw(pts, hit ? [h, lnE] : null, true);
        if (hit) {
          const auto = $('#opAuto').checked;
          addProp(LADDER[rung], LADDER[rung + 1], auto);
          if (auto) advance();
          return true;
        }
        return h >= HOURS;
      };
      if (reducedMotion()) { while (!step()); return; }
      timer = setInterval(() => { if (step()) clearInterval(timer); }, 110);
    }
    $('#opRun').addEventListener('click', run);
    $('#opReset').addEventListener('click', reset);
    reset();
  })();

  // ---------------------------------------------------------------- 09 natural language (filled from nl-data.js once captured)
  (function nl() {
    const d = window.SB_NL;
    if (!d) return;
    $('#s-nl').hidden = false;
    $('#nlLede').textContent = d.lede;
    $('#nlBody').innerHTML = d.html;
  })();

  // ---------------------------------------------------------------- 10 governance
  (function governance() {
    let step = 0;
    const items = $$('#gvFlow li');
    const render = () => items.forEach((li, i) => li.classList.toggle('on', i < step));
    $('#gvNext').addEventListener('click', () => { step = Math.min(items.length, step + 1); render(); });
    $('#gvReset').addEventListener('click', () => { step = 0; render(); });
    render();

    const P = [['FLAG_READ', 'View flags'], ['FLAG_WRITE', 'Edit targeting'], ['FLAG_KILL', 'Kill switch'], ['FLAG_ROLLBACK', 'Roll back'], ['SEGMENT_WRITE', 'Edit segments'], ['APPROVE_CHANGES', 'Approve'], ['VIEW_AUDIT', 'Audit log'], ['MANAGE_MEMBERS', 'People & roles'], ['MANAGE_SDK_KEYS', 'SDK keys'], ['MANAGE_PROJECTS', 'Projects'], ['MANAGE_ENVIRONMENTS', 'Environments'], ['MANAGE_SETTINGS', 'Org settings']];
    const ALL = P.map((p) => p[0]);
    const R = {
      Owner: ALL,
      Admin: ALL.filter((p) => p !== 'MANAGE_SETTINGS'),
      Member: ['FLAG_READ', 'FLAG_WRITE', 'FLAG_KILL', 'FLAG_ROLLBACK', 'SEGMENT_WRITE', 'MANAGE_PROJECTS', 'VIEW_AUDIT'],
      Maintainer: ['FLAG_READ', 'FLAG_WRITE', 'FLAG_KILL', 'FLAG_ROLLBACK', 'SEGMENT_WRITE', 'VIEW_AUDIT'],
      Writer: ['FLAG_READ', 'FLAG_WRITE', 'SEGMENT_WRITE', 'VIEW_AUDIT'],
      Approver: ['FLAG_READ', 'APPROVE_CHANGES', 'VIEW_AUDIT'],
      Viewer: ['FLAG_READ', 'VIEW_AUDIT'],
    };
    const t = $('#rbac');
    t.innerHTML = `<thead><tr><th scope="col">Role</th>${P.map(([, l]) => `<th scope="col">${esc(l)}</th>`).join('')}</tr></thead><tbody>${Object.entries(R).map(([role, ps]) => `<tr><th scope="row">${role}</th>${ALL.map((p) => `<td class="${ps.includes(p) ? 'y' : 'n'}" aria-label="${ps.includes(p) ? 'yes' : 'no'}"></td>`).join('')}</tr>`).join('')}</tbody>`;
    t.addEventListener('click', (e) => {
      const tr = e.target.closest('tbody tr');
      if (!tr) return;
      const was = tr.classList.contains('sel');
      $$('tr', t).forEach((r) => r.classList.remove('sel'));
      if (!was) tr.classList.add('sel');
    });
  })();

  // ---------------------------------------------------------------- 12 MCP transcript
  (function mcp() {
    const script = [
      ['user', 'Checkout errors are spiking. Is it a flag?'],
      ['tool', '<span class="t">list_anomalies</span>({ projectId: "storefront-app", envKey: "production" })\n→ payment-provider-v3 · error · variation True 40.5% vs False 4.3% · rolled back automatically'],
      ['bot', 'Yes. payment-provider-v3 in production: the new provider erred at 40.5% against 4.3%. The monitor already rolled it back to the old provider, so users are safe. Want me to keep it off while you investigate?'],
      ['user', 'Also bump new-checkout in staging to 75%.'],
      ['tool', '<span class="t">update_targeting</span>({ flagKey: "new-checkout", envKey: "staging", … 75/25 … })\n→ { "applied": false, "queued": true,\n    "summary": "Targeting update was NOT applied. This environment requires approval, so the change is waiting for a human reviewer. Do not report it as done." }'],
      ['bot', 'I did not change staging. It requires approval, so I opened a change request for 50% → 75%. Someone with approval rights needs to approve it in Change requests.'],
    ];
    const chat = $('#mcpChat');
    script.forEach(([who, text]) => { const m = el('div', { class: 'msg ' + who }); m.innerHTML = who === 'tool' ? text : esc(text); m.hidden = true; chat.append(m); });
    const msgs = $$('.msg', chat);
    let shown = 1;
    const render = () => { msgs.forEach((m, i) => { m.hidden = i >= shown; }); $('#mcpNext').disabled = shown >= msgs.length; };
    $('#mcpNext').addEventListener('click', () => { shown++; render(); });
    $('#mcpReset').addEventListener('click', () => { shown = 1; render(); });
    render();
  })();

  // ---------------------------------------------------------------- 13 performance dot plot
  (function perf() {
    const data = [
      ['Single evaluation', 0.68, 4.91, true], ['Bulk evaluation (50 flags)', 0.57, 4.59], ['Bootstrap, unchanged (304)', 0.74, 8.08],
      ['Bootstrap, full payload', 0.79, 15.77], ['OFREP evaluation', 0.84, 6.24], ['Flag list, cached', 0.70, 4.79, true],
      ['Event ingest', 2.06, 62.10], ['Flag list, before caching', 2.87, 73.82],
    ];
    const W = 760, rowH = 34, T = 10, B = 30, L = 210, R = 20, H = T + B + rowH * data.length;
    const lo = Math.log10(0.3), hi = Math.log10(100);
    const x = (v) => L + ((Math.log10(v) - lo) / (hi - lo)) * (W - L - R);
    const ticks = [0.5, 1, 2, 5, 10, 20, 50, 100];
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="p50 and p99 latency per path, log scale in milliseconds"><g class="grid">`;
    ticks.forEach((t) => { s += `<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}"/>`; });
    s += '</g>';
    ticks.forEach((t) => { s += `<text class="ax" x="${x(t)}" y="${H - 10}" text-anchor="middle">${t} ms</text>`; });
    data.forEach(([name, p50, p99, hl], i) => {
      const cy = T + rowH * i + rowH / 2;
      s += `<g class="${hl ? 'hl' : ''}"><title>${name}: p50 ${p50} ms, p99 ${p99} ms</title>`;
      s += `<text class="name" x="${L - 12}" y="${cy + 4}" text-anchor="end">${name}</text>`;
      s += `<line class="span" x1="${x(p50)}" x2="${x(p99)}" y1="${cy}" y2="${cy}"/>`;
      s += `<circle class="p50" cx="${x(p50)}" cy="${cy}" r="6"/><circle class="p99" cx="${x(p99)}" cy="${cy}" r="6"/>`;
      s += `<text class="ax" x="${x(p99) + 10}" y="${cy + 4}">${p99}</text></g>`;
    });
    $('#perfPlot').innerHTML = s + '</svg>';
  })();

  buildNav();
  onScroll();
})();
