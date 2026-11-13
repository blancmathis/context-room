// « Skills & MCP » on the page of one project (decision 11): every skill and MCP server the providers find, level by
// level (global, project root, subfolders), with who reads it, its source file, its token cost and same-name warnings.
// Loaded on the first press from the project page. Read-only: the server sends names and sources, never a value.

/* global escapeHtml, api, formatTokenEstimate */

const CSS = `
.sm{display:grid;gap:12px;padding:14px 16px}
.sm-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.sm-head h2{margin:0;font-size:15px}
.sm-head [data-sm-close]{margin-left:auto}
.sm-seg{display:flex;flex-wrap:wrap;gap:6px}
.sm-seg button{min-height:32px;padding:4px 12px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);font:inherit;font-size:13px;cursor:pointer}
.sm-seg button[aria-pressed=true]{border-color:var(--accent);color:var(--text);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.sm-note,.sm-empty{margin:0;color:var(--muted);font-size:13px}
.sm-level{border-top:1px solid var(--line)}
.sm-level summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;padding:10px 0;cursor:pointer}
.sm-level summary span{color:var(--muted);font-size:13px}
.sm-level .sm-empty{padding-bottom:10px}
.sm-list{display:grid;margin:0 0 8px;padding:0;list-style:none}
.sm-list li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:baseline;gap:2px 14px;padding:8px 0;border-top:1px solid color-mix(in srgb,var(--line) 55%,transparent)}
.sm-list small{grid-column:1/-1;color:var(--muted);overflow-wrap:anywhere}
.sm-list .sm-src{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.sm-list .sm-dup{color:var(--warning);border-color:color-mix(in srgb,var(--warning) 55%,transparent)}
.sm-name{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0;font-weight:600;overflow-wrap:anywhere}
.sm-chips{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.sm-list i{font-style:normal;font-weight:400;font-size:12px;padding:1px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);white-space:nowrap}
.sm-tok{min-width:15em;color:var(--muted);font-size:13px;text-align:right;font-variant-numeric:tabular-nums}
@media (max-width:639px){.sm-head h2{flex:1}.sm-head .sm-seg{order:1;flex-basis:100%}.sm-list li{grid-template-columns:minmax(0,1fr)}.sm-chips{justify-content:flex-start}.sm-tok{min-width:0;text-align:left}}
@media (pointer:coarse){.sm-seg button,.sm-head button,.sm .pp-link{min-height:44px}}
`;

const LEVELS = { global: 'Global', root: 'Project root' };
const STATUS = { configured: 'Configured', disabled: 'Disabled', approval: 'Needs approval' };
const levelName = (level) => Object.hasOwn(LEVELS, level) ? LEVELS[level] : level + '/';
const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');
const sum = (items, key) => items.reduce((total, item) => total + (item[key] || 0), 0);
export const countItems = (levels) => levels.reduce((total, level) => total + level.items.length, 0);

/** The levels as one provider sees them ('' = every provider): its items, its same-name warnings, its token totals. */
export function filterLevels(levels = [], provider = '') {
  return levels.map((level) => {
    const items = level.items.filter((item) => !provider || item.providers.includes(provider))
      .map((item) => ({ ...item, duplicates: item.duplicates.filter((other) => !provider || other.providers.includes(provider)) }));
    return { level: level.level, items, startupTokens: sum(items, 'startupTokens'), onDemandTokens: sum(items, 'onDemandTokens') };
  }).filter((level) => level.items.length || Object.hasOwn(LEVELS, level.level));
}

export function createSkillsMcp(anchor, openFile, onClose) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const section = document.createElement('section');
  section.id = 'projectSkillsMcp';
  section.className = 'docqa-panel sm';
  section.setAttribute('aria-labelledby', 'projectSkillsMcpHeading');
  section.hidden = true;
  anchor.after(section);
  const closed = new Set();
  let key = '';
  let data = null;
  let tab = 'skills';
  let provider = '';

  const pressed = (name, value, text) => '<button type="button" data-sm-' + name + '="' + escapeHtml(value) + '" aria-pressed="' + ((name === 'tab' ? tab : provider) === value) + '">' + escapeHtml(text) + '</button>';

  function render() {
    const head = (tabs) => '<div class="sm-head"><h2 id="projectSkillsMcpHeading">Skills &amp; MCP</h2>' + tabs + '<button class="secondary" type="button" data-sm-close>Close</button></div>';
    if (!data || data.error) {
      section.innerHTML = head('') + '<p class="sm-empty">' + (data ? escapeHtml(data.error) : 'Reading skills and MCP servers…') + '</p>';
      return;
    }
    const labels = Object.fromEntries(data.providers.map((item) => [item.id, item.label]));
    const names = (ids) => ids.map((id) => labels[id] || id);
    const levels = filterLevels(data[tab], provider);
    const total = countItems(levels);
    const skills = tab === 'skills';
    const word = skills ? 'skill' : 'server';
    const what = skills ? 'content' : 'settings';
    // An MCP file in a subfolder counts only for an agent started there; a skills folder is found from the root too.
    const scope = (level) => level === 'global' ? 'Every project on this device · ' : skills || level === 'root' ? '' : 'For an agent started in this folder · ';
    const doubled = levels.some((level) => level.items.some((item) => item.duplicates.length));
    const note = (skills
      ? (provider
        ? labels[provider] + ' finds ' + plural(total, 'skill') + ': ' + formatTokenEstimate(sum(levels, 'startupTokens')) + ' tokens at start (names and descriptions), ' + formatTokenEstimate(sum(levels, 'onDemandTokens')) + ' on demand (a body loads when its skill runs).'
        : plural(total, 'skill file') + '. An agent loads names and descriptions at start; a body loads when its skill runs. Pick a provider to see its own total.')
      : 'Tool definitions come from the running server: their token cost is not measured. Commands, URLs and keys are never shown.')
      + (doubled ? ' Two with one name: the provider keeps one. Context Room cannot tell which.' : '')
      + (data.truncated ? ' The list is cut: too many entries.' : '');
    const row = (item) => '<li><span class="sm-name">'
      + (item.path ? '<button type="button" class="pp-link" data-sm-open="' + escapeHtml(item.path) + '">' + escapeHtml(item.name) + '</button>' : escapeHtml(item.name))
      + (item.duplicates.length ? '<i' + (item.duplicates.some((other) => other.same === false) ? ' class="sm-dup"' : '') + '>Duplicate name</i>' : '') + (item.local ? '<i>This project only</i>' : '') + '</span>'
      + '<span class="sm-chips">' + names(item.providers).map((label) => '<i>' + escapeHtml(label) + '</i>').join('') + '</span>'
      + '<span class="sm-tok">' + (skills ? formatTokenEstimate(item.startupTokens) + ' at start · ' + formatTokenEstimate(item.onDemandTokens) + ' on demand' : STATUS[item.status] || '') + '</span>'
      + (item.description ? '<small>' + escapeHtml(item.description) + '</small>' : '')
      + '<small class="sm-src">' + escapeHtml(item.source) + '</small>'
      + item.duplicates.map((other) => '<small' + (other.same === false ? ' class="sm-dup"' : '') + '>' + escapeHtml('Same name in ' + levelName(other.level) + ' · ' + other.source
        + (other.same ? ' · same ' + what : other.same === false ? ' · different ' + what : '') + (provider ? '' : ' · for ' + names(other.providers).join(', '))) + '</small>').join('')
      + '</li>';
    section.innerHTML = head('<div class="sm-seg" role="group" aria-label="Show">' + pressed('tab', 'skills', 'Skills · ' + countItems(filterLevels(data.skills, provider))) + pressed('tab', 'mcp', 'MCP servers · ' + countItems(filterLevels(data.mcp, provider))) + '</div>')
      + '<div class="sm-seg" role="group" aria-label="Provider">' + pressed('provider', '', 'All') + data.providers.map((item) => pressed('provider', item.id, item.label + ' · ' + countItems(filterLevels(data[tab], item.id)))).join('') + '</div>'
      + '<p class="sm-note">' + escapeHtml(note) + '</p>'
      + levels.map((level) => '<details class="sm-level" data-sm-level="' + escapeHtml(level.level) + '"' + (closed.has(tab + ':' + level.level) ? '' : ' open') + '><summary><strong>' + escapeHtml(levelName(level.level)) + '</strong><span>'
        + scope(level.level) + plural(level.items.length, word)
        + (skills && level.items.length ? ' · ' + formatTokenEstimate(level.startupTokens) + ' at start · ' + formatTokenEstimate(level.onDemandTokens) + ' on demand' : '') + '</span></summary>'
        + (level.items.length ? '<ul class="sm-list">' + level.items.map(row).join('') + '</ul>' : '<p class="sm-empty">No ' + word + ' here.</p>') + '</details>').join('');
  }

  section.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.smOpen) return openFile(button.dataset.smOpen);
    if (button.matches('[data-sm-close]')) return onClose();
    const focus = button.dataset.smTab != null ? 'tab' : button.dataset.smProvider != null ? 'provider' : '';
    if (!focus) return;
    if (focus === 'tab') tab = button.dataset.smTab;
    else provider = button.dataset.smProvider;
    render();
    // The list is drawn again: the pressed button keeps the focus.
    section.querySelector('[data-sm-' + focus + '][aria-pressed=true]')?.focus();
  });
  // A level stays closed across a change of tab or provider (the toggle event does not bubble: capture it).
  section.addEventListener('toggle', (event) => {
    const level = event.target.dataset?.smLevel;
    if (level) closed[event.target.open ? 'delete' : 'add'](tab + ':' + level);
  }, true);

  return {
    /** Shows the skills and MCP servers of one local copy; '' hides the panel and drops what was read. */
    show(id) {
      const opening = section.hidden && id;
      section.hidden = !id;
      if (!id) {
        key = '';
        data = null;
        return;
      }
      if (opening) window.requestAnimationFrame(() => section.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      if (id === key) return;
      key = id;
      data = null;
      render();
      api('/api/context-hub/project-tools?projectId=' + encodeURIComponent(id))
        .then((value) => { if (key === id) data = value; }, (error) => { if (key === id) data = { error: error.message }; })
        .finally(() => { if (key === id) render(); });
    },
  };
}
