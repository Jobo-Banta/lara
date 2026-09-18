'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const labels = {not_started:'Not started',in_progress:'In progress',blocked:'Blocked',in_review:'In review',done:'Done',ready:'Ready for release',shipped:'Shipped'};
  const purposes = {engineering:'Engineering baseline',synthetic_demo:'Demoable prototype · synthetic data',production_scoped:'Production module · scoped activation'};
  let data = window.LARA_BUILD_STATUS;
  let loading = false;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const formatTime = value => value ? new Intl.DateTimeFormat('en-PH', {dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Manila'}).format(new Date(value)) + ' PHT' : 'No updates yet';
  const badge = state => `<span class="badge ${escape(state)}">${escape(labels[state] || state)}</span>`;
  function moduleState(release, tickets) {
    if (release.released_at) return 'shipped';
    if (tickets.some(t => t.status === 'blocked')) return 'blocked';
    if (tickets.length && tickets.every(t => t.status === 'done')) return 'ready';
    if (tickets.some(t => t.status === 'in_progress')) return 'in_progress';
    if (tickets.some(t => t.status === 'in_review')) return 'in_review';
    if (tickets.some(t => t.status === 'done')) return 'in_progress';
    return 'not_started';
  }
  function valid(value) {
    if (!value || !Array.isArray(value.releases) || !value.releases.length || !Array.isArray(value.tickets) || !Array.isArray(value.history)) return false;
    if (!Number.isFinite(Date.parse(value.updated_at))) return false;
    const ids = new Set(value.releases.map(r => r.id));
    return ids.size === value.releases.length && new Set(value.tickets.map(t => t.id)).size === value.tickets.length &&
      value.releases.every(r => /^[A-Z0-9]+$/.test(r.id) && Array.isArray(r.depends_on) && Array.isArray(r.conditional_dependencies) && r.depends_on.every(d => ids.has(d)) && typeof r.spec === 'string' && /^(?:phases\/)?[a-z0-9-]+\.md$/.test(r.spec)) &&
      value.tickets.every(t => ids.has(t.phase) && ['not_started','in_progress','blocked','in_review','done'].includes(t.status));
  }
  function render() {
    const expanded = new Set([...document.querySelectorAll('details[open]')].map(el => el.id));
    const done = data.tickets.filter(t => t.status === 'done').length;
    const shipped = data.releases.filter(r => r.released_at).length;
    $('shipped').textContent = `${shipped} / ${data.releases.length}`;
    $('completed').textContent = `${done} / ${data.tickets.length}`;
    $('percentage').textContent = `${Math.round(done / data.tickets.length * 100)}% · unweighted ticket count`;
    $('active').textContent = data.tickets.filter(t => ['in_progress','in_review'].includes(t.status)).length;
    $('blocked').textContent = data.tickets.filter(t => t.status === 'blocked').length;
    $('updated').textContent = `Data updated ${formatTime(data.updated_at)}`;
    const next = data.releases.find(r => !r.released_at);
    const nextTickets = next ? data.tickets.filter(t => t.phase === next.id) : [];
    const nextDone = nextTickets.filter(t => t.status === 'done').length;
    $('next-title').textContent = next ? `${next.id} · ${next.title}` : 'All planned releases shipped';
    $('next-description').textContent = next ? `${purposes[next.purpose]}. ${next.depends_on.length ? 'Required releases: ' + next.depends_on.join(', ') + '.' : 'No prior release dependencies.'}` : 'Continue monitoring production and recording improvements.';
    $('next-count').textContent = next ? `${nextDone} of ${nextTickets.length} tickets complete` : 'Roadmap complete';
    $('next-progress').value = next ? nextDone / nextTickets.length * 100 : 100;
    const query = $('search').value.toLowerCase().trim();
    const filter = $('status-filter').value;
    let count = 0;
    $('releases').innerHTML = data.releases.map(r => {
      const tickets = data.tickets.filter(t => t.phase === r.id);
      const state = moduleState(r,tickets);
      const searchable = [r.id,r.title,...tickets.flatMap(t => [t.id,t.title,t.owner,t.note])].join(' ').toLowerCase();
      if ((query && !searchable.includes(query)) || (filter !== 'all' && filter !== state)) return '';
      count++;
      const finished = tickets.filter(t => t.status === 'done').length;
      const percent = Math.round(finished / tickets.length * 100);
      const pending = r.depends_on.filter(id => !data.releases.find(d => d.id === id).released_at);
      const dependencyText = r.depends_on.length ? r.depends_on.map(id => `${id}${pending.includes(id) ? ' (pending)' : ' (shipped)'}`).join(', ') : 'None';
      const conditional = r.conditional_dependencies.map(d => typeof d === 'string' ? d : JSON.stringify(d)).join('; ');
      return `<details id="release-${r.id}" ${expanded.has(`release-${r.id}`) ? 'open' : ''}>
        <summary><span class="phase-id">${r.id}</span><span><span class="module-title">${escape(r.title)}</span><span class="purpose">${escape(purposes[r.purpose])}</span></span>${badge(state)}<span class="mini-progress">${finished} / ${tickets.length} · ${percent}%<progress max="100" value="${percent}" aria-label="${r.id} ticket completion"></progress></span><span class="chevron" aria-hidden="true">›</span></summary>
        <div class="detail-body"><div class="detail-meta"><a href="docs/development/${encodeURI(r.spec)}">Open implementation specification ↗</a><p><strong>Required releases:</strong> ${escape(dependencyText)}</p><p><strong>Gate:</strong> ${escape(r.release_gate)}</p>${conditional ? `<p><strong>Conditional dependencies:</strong> ${escape(conditional)}</p>` : ''}<p class="evidence"><strong>Release evidence:</strong> ${escape(r.evidence || 'Not recorded. Ticket completion alone does not mark a release shipped.')}</p>${r.released_at ? `<p>Released ${escape(formatTime(r.released_at))}</p>` : ''}</div>
        <div class="table-wrap" role="region" aria-label="${r.id} implementation tickets" tabindex="0"><table><thead><tr><th scope="col">Ticket</th><th scope="col">Work & acceptance</th><th scope="col">Status</th><th scope="col">Owner / update</th></tr></thead><tbody>${tickets.map(t => `<tr><td>${escape(t.id)}</td><td><strong>${escape(t.title)}</strong><span class="ticket-detail">${escape(t.implementation)}</span><span class="ticket-detail">Acceptance: ${escape(t.acceptance)} · Preceding tickets: ${escape(t.depends_on.join(', ') || 'None')}</span>${t.note ? `<span class="ticket-detail">Note: ${escape(t.note)}</span>` : ''}${t.evidence ? `<span class="ticket-detail evidence">Evidence: ${escape(t.evidence)}</span>` : ''}</td><td>${badge(t.status)}</td><td>${escape(t.owner || 'Unassigned')}<span class="ticket-detail">${escape(formatTime(t.updated_at))}</span></td></tr>`).join('')}</tbody></table></div></div></details>`;
    }).join('');
    $('results').textContent = `${count} of ${data.releases.length} increments`;
    $('empty').hidden = count !== 0;
    $('history').innerHTML = data.history.length ? [...data.history].reverse().map(h => `<li><strong>${escape(h.id)}</strong> · ${escape(labels[h.action] || h.action)}${h.note ? ' — ' + escape(h.note) : ''}<time>${escape(formatTime(h.at))}</time></li>`).join('') : '<li>No implementation updates yet. The roadmap is specified; build work has not been recorded.</li>';
  }
  async function refresh() {
    if (loading) return;
    if (location.protocol === 'file:') {
      $('connection').textContent = 'Local snapshot · reload after updates';
      return;
    }
    loading = true;
    $('refresh').disabled = true;
    try {
      const response = await fetch(`status/build-status-view.json?t=${Date.now()}`, {cache:'no-store', signal:AbortSignal.timeout(4000)});
      if (!response.ok) throw new Error('Status unavailable');
      const candidate = await response.json();
      if (!valid(candidate)) throw new Error('Invalid status data');
      if (JSON.stringify(candidate) !== JSON.stringify(data)) { data = candidate; render(); }
      $('connection').textContent = 'Live · refreshes every 5 seconds';
    } catch {
      $('connection').textContent = 'Connection unavailable · showing last snapshot';
    } finally {
      loading = false;
      $('refresh').disabled = false;
    }
  }
  if (!valid(data)) { $('connection').textContent = 'Status data unavailable · run tracker sync'; return; }
  $('search').addEventListener('input',render);
  $('status-filter').addEventListener('change',render);
  $('clear').addEventListener('click',() => { $('search').value=''; $('status-filter').value='all'; render(); });
  $('refresh').addEventListener('click',() => location.protocol === 'file:' ? location.reload() : refresh());
  render();
  refresh();
  if (location.protocol !== 'file:') setInterval(refresh,5000);
})();
