/**
 * Browser script injected into Swagger UI (served as a theme file, same origin).
 * 1. Captures the Swagger UI instance (the bundle does not expose it on `window`).
 * 2. "Logged in as" banner: decodes the pasted JWT payload locally (never sent anywhere) and
 *    shows name / subject, roles and expiry.
 * 3. Quick links (`#/<Tag>`): open only that section and scroll to it.
 */
export const DOCS_UI_SCRIPT = String.raw`(function () {
  'use strict';
  var original = window.SwaggerUIBundle;
  if (typeof original !== 'function') return;
  function wrapped(config) {
    var ui = original(config);
    window.ui = ui;
    start(ui);
    return ui;
  }
  Object.keys(original).forEach(function (key) { wrapped[key] = original[key]; });
  window.SwaggerUIBundle = wrapped;

  function decodeJwt(token) {
    try {
      var part = token.split('.')[1];
      if (!part) return null;
      part = part.replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      var json = decodeURIComponent(atob(part).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function text(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function banner() {
    var el = document.getElementById('farmx-auth-banner');
    if (el) return el;
    var anchor = document.querySelector('.swagger-ui .information-container');
    if (!anchor) return null;
    el = document.createElement('div');
    el.id = 'farmx-auth-banner';
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
    return el;
  }

  var last = '';
  function renderAuth(ui) {
    var el = banner();
    if (!el) return;
    var auth = ui.authSelectors.authorized();
    var token = auth && auth.getIn ? auth.getIn(['bearerAuth', 'value']) : null;
    var key = token || '';
    if (key === last) return;
    last = key;
    if (!token) {
      el.className = 'farmx-auth farmx-auth--none';
      el.innerHTML = 'Not logged in — click <b>Authorize</b> and paste an access token.';
      return;
    }
    var claims = decodeJwt(token);
    if (!claims) {
      el.className = 'farmx-auth farmx-auth--bad';
      el.innerHTML = 'The token is not a valid JWT.';
      return;
    }
    var who = claims.name || claims.fullName || claims.email || claims.sub || 'unknown user';
    var roles = claims.roles || claims.role || [];
    if (!Array.isArray(roles)) roles = [roles];
    var expired = typeof claims.exp === 'number' && claims.exp * 1000 < Date.now();
    var expiry = typeof claims.exp === 'number' ? new Date(claims.exp * 1000).toLocaleString() : 'no expiry';
    el.className = 'farmx-auth ' + (expired ? 'farmx-auth--bad' : 'farmx-auth--ok');
    el.innerHTML = 'Logged in as <b>' + text(who) + '</b>' +
      (claims.sub && claims.sub !== who ? ' <span class="farmx-muted">(' + text(claims.sub) + ')</span>' : '') +
      ' · roles: <b>' + (roles.length ? roles.map(text).join(', ') : 'none') + '</b>' +
      ' · ' + (expired ? '<b>expired</b> ' : 'expires ') + text(expiry);
  }

  function openOnlyTag(ui, tag) {
    var tags = ui.specSelectors.taggedOperations().keySeq().toArray();
    tags.forEach(function (name) { ui.layoutActions.show(['operations-tag', name], name === tag); });
    setTimeout(function () {
      var id = 'operations-tag-' + tag.replace(/\s/g, '_');
      var el = document.getElementById(id) || document.getElementById('operations-tag-' + tag);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  function onHash(ui) {
    var match = /^#\/([^/]+)$/.exec(window.location.hash);
    if (match) openOnlyTag(ui, decodeURIComponent(match[1]));
  }

  function start(ui) {
    setInterval(function () { renderAuth(ui); }, 500);
    window.addEventListener('hashchange', function () { onHash(ui); });
  }
})();
`;

export const DOCS_UI_CSS = `
.farmx-auth { margin: 0 0 16px; padding: 10px 14px; border-radius: 6px; font: 14px/1.4 sans-serif; }
.farmx-auth--none { background: #f3f4f6; color: #374151; }
.farmx-auth--ok { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
.farmx-auth--bad { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
.farmx-muted { opacity: 0.7; }
.swagger-ui .info .description a { font-weight: 600; }
`;
