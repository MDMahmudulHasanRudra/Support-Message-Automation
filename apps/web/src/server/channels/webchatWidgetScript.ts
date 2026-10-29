/**
 * The embeddable website chat widget (WEBSITE_CHAT.md), served as plain JavaScript by
 * /api/webchat/widget.js. No framework, no third-party code, one file.
 *
 *   <script src="https://<this app>/api/webchat/widget.js" data-key="<widget key>" async></script>
 *
 * Optional, before it: window.GetAssistChat = { user: { id, name, email, hash } } where `hash` is
 * HMAC-SHA256(identity secret, id) computed on the site's SERVER — never in the browser.
 *
 * Safety: everything renders inside a closed Shadow DOM; every message is set with textContent (never
 * HTML), so nothing a visitor or agent types can run as code on the host page. The token is kept in
 * localStorage per widget key and sent as a bearer header; it only ever reads its own conversation.
 */
export const WIDGET_SCRIPT = String.raw`(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || window.__getAssistChatLoaded) return;
  window.__getAssistChatLoaded = true;
  var key = script.getAttribute("data-key");
  if (!key) return;
  var base = new URL(script.src).origin + "/api/webchat/" + encodeURIComponent(key);
  var storeKey = "getassist-chat-" + key;
  var opts = window.GetAssistChat || {};
  var state = { token: null, open: false, messages: [], pending: [], last: null, unread: 0, cfg: null, timer: null, starting: null };

  function load() { try { var v = JSON.parse(localStorage.getItem(storeKey) || "{}"); state.token = v.token || null; } catch (e) {} }
  function save() { try { localStorage.setItem(storeKey, JSON.stringify({ token: state.token })); } catch (e) {} }
  function api(path, init) {
    init = init || {};
    init.headers = init.headers || {};
    if (state.token) init.headers.Authorization = "Bearer " + state.token;
    if (init.body) init.headers["Content-Type"] = "application/json";
    return fetch(base + path, init).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error || "Something went wrong."); return j; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function nonce() { var a = new Uint8Array(12); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }

  load();
  api("", { method: "GET" }).then(function (cfg) { state.cfg = cfg; build(); }).catch(function () { /* not allowed here, or switched off: render nothing */ });

  var root, shadow, panel, list, input, sendBtn, bubble, badge, form, note, pre;
  function build() {
    var c = state.cfg.settings;
    root = document.createElement("div");
    root.style.cssText = "position:fixed;z-index:2147483000;bottom:20px;" + (c.position === "left" ? "left:20px" : "right:20px");
    shadow = root.attachShadow({ mode: "closed" });
    var style = el("style");
    style.textContent = [
      ":host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
      ".b{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:" + c.color + ";color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;position:relative}",
      ".b:focus-visible,.s:focus-visible,.x:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}",
      ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;background:#dc2626;color:#fff;font-size:11px;line-height:18px;text-align:center;padding:0 4px;display:none}",
      ".p{position:absolute;bottom:70px;" + (c.position === "left" ? "left:0" : "right:0") + ";width:360px;height:520px;max-height:calc(100vh - 110px);background:#fff;color:#111;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden}",
      ".p.o{display:flex}.h{background:" + c.color + ";color:#fff;padding:14px 16px;display:flex;align-items:flex-start;gap:8px}.h h2{margin:0;font-size:15px;font-weight:600}.h p{margin:2px 0 0;font-size:12px;opacity:.85}",
      ".x{margin-left:auto;background:transparent;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1}",
      ".l{flex:1;overflow-y:auto;padding:12px;background:#f8fafc;display:flex;flex-direction:column;gap:6px}",
      ".m{max-width:80%;padding:8px 11px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".m.v{align-self:flex-end;background:" + c.color + ";color:#fff;border-bottom-right-radius:4px}.m.t{align-self:flex-start;background:#fff;border:1px solid #e2e8f0;border-bottom-left-radius:4px}",
      ".m.pend{opacity:.6}.a{font-size:11px;color:#64748b;margin:4px 2px 0}.a.r{align-self:flex-end}",
      ".f{display:flex;gap:6px;padding:10px;border-top:1px solid #e2e8f0;background:#fff}.f textarea{flex:1;resize:none;border:1px solid #cbd5e1;border-radius:10px;padding:8px 10px;font-size:14px;max-height:120px}",
      ".s{border:0;border-radius:10px;padding:0 14px;background:" + c.color + ";color:#fff;font-weight:600;cursor:pointer}.s:disabled{opacity:.5;cursor:default}",
      ".pre{padding:12px;display:flex;flex-direction:column;gap:8px;border-top:1px solid #e2e8f0}.pre input{border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;font-size:14px}",
      ".n{font-size:12px;color:#b91c1c;padding:0 12px 8px;background:#fff}",
      "@media (max-width:480px){.p{position:fixed;inset:0;width:auto;height:auto;max-height:none;border-radius:0}}",
    ].join("");
    shadow.appendChild(style);

    bubble = el("button", "b");
    bubble.setAttribute("aria-label", c.title);
    bubble.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    badge = el("span", "badge");
    bubble.appendChild(badge);
    bubble.onclick = function () { toggle(!state.open); };

    panel = el("div", "p");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", c.title);
    var head = el("div", "h");
    var titles = el("div");
    titles.appendChild(el("h2", null, c.title));
    if (c.replyNote) titles.appendChild(el("p", null, c.replyNote));
    var close = el("button", "x", "×");
    close.setAttribute("aria-label", "Close chat");
    close.onclick = function () { toggle(false); };
    head.appendChild(titles);
    head.appendChild(close);
    list = el("div", "l");
    list.setAttribute("role", "log");
    list.setAttribute("aria-live", "polite");
    note = el("div", "n");
    form = el("form", "f");
    input = el("textarea");
    input.rows = 1;
    input.maxLength = 2000;
    input.placeholder = "Write a message…";
    input.setAttribute("aria-label", "Message");
    input.onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
    sendBtn = el("button", "s", "Send");
    sendBtn.type = "submit";
    form.appendChild(input);
    form.appendChild(sendBtn);
    form.onsubmit = function (e) { e.preventDefault(); send(); };

    pre = null;
    var signed = opts.user && opts.user.id && opts.user.hash;
    if (!state.token && !signed && (c.askName || c.askEmail)) {
      pre = el("div", "pre");
      if (c.askName) { var n = el("input"); n.placeholder = "Your name (optional)"; n.maxLength = 80; n.setAttribute("aria-label", "Your name"); n.dataset.f = "name"; pre.appendChild(n); }
      if (c.askEmail) { var m = el("input"); m.type = "email"; m.placeholder = "Your email (optional)"; m.maxLength = 120; m.setAttribute("aria-label", "Your email"); m.dataset.f = "email"; pre.appendChild(m); }
    }
    panel.appendChild(head);
    panel.appendChild(list);
    panel.appendChild(note);
    if (pre) panel.appendChild(pre);
    panel.appendChild(form);
    shadow.appendChild(panel);
    shadow.appendChild(bubble);
    document.body.appendChild(root);
    if (!state.cfg.enabled) { input.disabled = true; sendBtn.disabled = true; note.textContent = "Chat is not available right now."; }
    render();
    if (state.token) poll();
    schedule();
  }

  function toggle(open) {
    state.open = open;
    panel.className = open ? "p o" : "p";
    if (open) { state.unread = 0; render(); input.focus(); poll(); } else bubble.focus();
    schedule();
  }

  function schedule() {
    clearTimeout(state.timer);
    if (!state.token) return;
    state.timer = setTimeout(function () { poll(); schedule(); }, state.open ? 3000 : 30000);
  }

  function ensureSession() {
    if (state.token) return Promise.resolve();
    if (state.starting) return state.starting;
    var body = { identity: opts.user || null };
    if (pre) Array.prototype.forEach.call(pre.querySelectorAll("input"), function (i) { body[i.dataset.f] = i.value; });
    state.starting = api("/session", { method: "POST", body: JSON.stringify(body) }).then(function (r) {
      state.token = r.token; save(); if (pre) { pre.remove(); pre = null; } schedule();
    }).finally(function () { state.starting = null; });
    return state.starting;
  }

  function send() {
    var text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    var n = nonce();
    state.pending.push({ nonce: n, text: text });
    input.value = "";
    note.textContent = "";
    render();
    ensureSession().then(function () {
      return api("/messages", { method: "POST", body: JSON.stringify({ text: text, nonce: n }) });
    }).catch(function (err) {
      state.pending = state.pending.filter(function (p) { return p.nonce !== n; });
      input.value = text;
      note.textContent = err.message || "Not sent. Try again.";
      render();
    });
  }

  function poll() {
    if (!state.token) return;
    api("/messages" + (state.last ? "?after=" + encodeURIComponent(state.last) : ""), { method: "GET" }).then(function (r) {
      var fresh = r.messages || [];
      fresh.forEach(function (m) {
        if (state.messages.some(function (x) { return x.id === m.id; })) return;
        state.messages.push(m);
        if (m.nonce) state.pending = state.pending.filter(function (p) { return p.nonce !== m.nonce; });
        if (m.from !== "visitor" && !state.open) state.unread++;
        state.last = m.at;
      });
      if (fresh.length) render();
    }).catch(function (err) {
      if (/expired|not found/i.test(err.message)) { state.token = null; save(); }
    });
  }

  function render() {
    if (!list) return;
    badge.style.display = state.unread ? "block" : "none";
    badge.textContent = state.unread > 9 ? "9+" : String(state.unread);
    list.textContent = "";
    if (state.cfg.settings.welcome) list.appendChild(el("div", "m t", state.cfg.settings.welcome));
    state.messages.forEach(function (m) {
      if (m.from !== "visitor") list.appendChild(el("div", "a", m.from === "ai" ? "AI assistant" : (m.author || state.cfg.name)));
      list.appendChild(el("div", "m " + (m.from === "visitor" ? "v" : "t"), m.text));
    });
    state.pending.forEach(function (p) { list.appendChild(el("div", "m v pend", p.text)); });
    list.scrollTop = list.scrollHeight;
  }
})();`;
