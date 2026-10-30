/**
 * The embeddable website chat widget (WEBSITE_CHAT.md), served as plain JavaScript by
 * /api/webchat/widget.js. No framework, no third-party code, one file.
 *
 *   <script src="https://<this app>/api/webchat/widget.js" data-key="<widget key>" async></script>
 *
 * Optional, before it: window.GetAssistChat = { user: { id, name, email, phone, hash } } where `hash` is
 * HMAC-SHA256(identity secret, id) computed on the site's SERVER — never in the browser.
 *
 * Safety: everything renders inside a closed Shadow DOM; every message is set with textContent (never
 * HTML), so nothing a visitor or agent types can run as code on the host page. The token is kept in
 * localStorage per widget key and sent as a bearer header; it only ever reads its own conversation.
 * The page address sent with a message is reduced to origin + path by the server.
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
  var state = { token: null, open: false, messages: [], pending: [], last: null, unread: 0, cfg: null, timer: null, starting: null, typingSent: 0, agentTyping: false, uploading: false };

  function load() { try { var v = JSON.parse(localStorage.getItem(storeKey) || "{}"); state.token = v.token || null; } catch (e) {} }
  function save() { try { localStorage.setItem(storeKey, JSON.stringify({ token: state.token })); } catch (e) {} }
  function api(path, init) {
    init = init || {};
    init.headers = init.headers || {};
    if (state.token) init.headers.Authorization = "Bearer " + state.token;
    if (init.body && typeof init.body === "string") init.headers["Content-Type"] = "application/json";
    return fetch(base + path, init).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error || "Something went wrong."); return j; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function nonce() { var a = new Uint8Array(12); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function contrast(hex) {
    var n = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#2563eb";
    function ch(i) { var c = parseInt(n.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5) > 0.45 ? "#0f172a" : "#ffffff";
  }
  function visible() { return state.open && document.visibilityState === "visible"; }

  load();
  api("", { method: "GET" }).then(function (cfg) { state.cfg = cfg; build(); }).catch(function () { /* not allowed here, or switched off: render nothing */ });

  var root, shadow, panel, list, input, sendBtn, attachBtn, fileInput, bubble, badge, form, note, pre, typingEl, sub;
  function build() {
    var c = state.cfg.settings;
    var ink = contrast(c.color);
    var offline = state.cfg.availability && !state.cfg.availability.open;
    var side = c.position === "left" ? "left" : "right";
    root = document.createElement("div");
    root.style.cssText = "position:fixed;z-index:2147483000;bottom:" + (Number(c.bottomOffset) || 20) + "px;" + side + ":20px";
    shadow = root.attachShadow({ mode: "closed" });
    var style = el("style");
    style.textContent = [
      ":host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
      ".w{display:flex;align-items:center;gap:10px;flex-direction:" + (side === "left" ? "row-reverse" : "row") + "}",
      ".lab{background:#fff;color:#0f172a;border-radius:20px;padding:8px 14px;font-size:14px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.15);cursor:pointer;border:0}",
      ".b{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;background:" + c.color + ";color:" + ink + ";box-shadow:0 6px 20px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;position:relative}",
      ".b:focus-visible,.s:focus-visible,.x:focus-visible,.at:focus-visible,.lab:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}",
      ".badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;background:#dc2626;color:#fff;font-size:11px;line-height:18px;text-align:center;padding:0 4px;display:none}",
      ".p{position:absolute;bottom:70px;" + side + ":0;width:360px;height:540px;max-height:calc(100vh - 110px);background:#fff;color:#111;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden}",
      ".p.o{display:flex}.h{background:" + c.color + ";color:" + ink + ";padding:14px 16px;display:flex;align-items:flex-start;gap:8px}.h h2{margin:0;font-size:15px;font-weight:600}.h p{margin:2px 0 0;font-size:12px;opacity:.85}",
      ".dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#22c55e}.dot.off{background:#94a3b8}",
      ".x{margin-left:auto;background:transparent;border:0;color:" + ink + ";font-size:22px;cursor:pointer;line-height:1;min-width:32px;min-height:32px}",
      ".l{flex:1;overflow-y:auto;padding:12px;background:#f8fafc;display:flex;flex-direction:column;gap:6px;overscroll-behavior:contain}",
      ".m{max-width:80%;padding:8px 11px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".m.v{align-self:flex-end;background:" + c.color + ";color:" + ink + ";border-bottom-right-radius:4px}.m.t{align-self:flex-start;background:#fff;border:1px solid #e2e8f0;border-bottom-left-radius:4px}",
      ".m.pend{opacity:.6}.a{font-size:11px;color:#64748b;margin:4px 2px 0}.file{display:block;font-size:12px;opacity:.9}",
      ".ty{font-size:12px;color:#64748b;padding:2px 14px 6px;background:#f8fafc;min-height:20px}",
      ".f{display:flex;gap:6px;padding:10px;border-top:1px solid #e2e8f0;background:#fff;align-items:flex-end}.f textarea{flex:1;resize:none;border:1px solid #cbd5e1;border-radius:10px;padding:8px 10px;font-size:14px;max-height:120px}",
      ".at{border:0;background:transparent;cursor:pointer;color:#64748b;padding:6px;border-radius:8px;min-width:36px;min-height:36px}",
      ".s{border:0;border-radius:10px;padding:0 14px;min-height:36px;background:" + c.color + ";color:" + ink + ";font-weight:600;cursor:pointer}.s:disabled,.at:disabled{opacity:.5;cursor:default}",
      ".pre{padding:12px;display:flex;flex-direction:column;gap:8px;border-top:1px solid #e2e8f0}.pre input{border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;font-size:14px}.pre p{margin:0;font-size:12px;color:#475569}",
      ".n{font-size:12px;color:#b91c1c;padding:0 12px 8px;background:#fff}",
      "@media (max-width:480px){.p{position:fixed;inset:0;width:auto;height:100%;max-height:none;border-radius:0;padding-bottom:env(safe-area-inset-bottom)}.f textarea,.pre input{font-size:16px}.lab{display:none}}",
    ].join("");
    shadow.appendChild(style);

    var wrap = el("div", "w");
    bubble = el("button", "b");
    bubble.setAttribute("aria-label", c.title);
    bubble.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    badge = el("span", "badge");
    bubble.appendChild(badge);
    bubble.onclick = function () { toggle(!state.open); };
    if (c.launcherLabel) { var lab = el("button", "lab", c.launcherLabel); lab.onclick = function () { toggle(true); }; wrap.appendChild(lab); }
    wrap.appendChild(bubble);

    panel = el("div", "p");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", c.title);
    var head = el("div", "h");
    var titles = el("div");
    titles.appendChild(el("h2", null, c.title));
    sub = el("p");
    var dot = el("span", offline ? "dot off" : "dot");
    sub.appendChild(dot);
    sub.appendChild(document.createTextNode(offline ? (c.offlineMessage + (state.cfg.availability.nextOpen ? " Back " + state.cfg.availability.nextOpen + "." : "")) : (c.replyNote || "Online")));
    titles.appendChild(sub);
    var close = el("button", "x", "×");
    close.setAttribute("aria-label", "Close chat");
    close.onclick = function () { toggle(false); };
    head.appendChild(titles);
    head.appendChild(close);
    list = el("div", "l");
    list.setAttribute("role", "log");
    list.setAttribute("aria-live", "polite");
    typingEl = el("div", "ty");
    typingEl.setAttribute("aria-live", "polite");
    note = el("div", "n");
    form = el("form", "f");
    input = el("textarea");
    input.rows = 1;
    input.maxLength = 2000;
    input.placeholder = "Write a message…";
    input.setAttribute("aria-label", "Message");
    input.onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
    input.oninput = function () { typing(); };
    if (c.allowAttachments) {
      attachBtn = el("button", "at");
      attachBtn.type = "button";
      attachBtn.setAttribute("aria-label", "Send a photo or PDF");
      attachBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
      fileInput = el("input");
      fileInput.type = "file";
      fileInput.accept = "image/jpeg,image/png,image/webp,application/pdf";
      fileInput.style.display = "none";
      fileInput.onchange = function () { if (fileInput.files && fileInput.files[0]) upload(fileInput.files[0]); fileInput.value = ""; };
      attachBtn.onclick = function () { fileInput.click(); };
      form.appendChild(attachBtn);
      form.appendChild(fileInput);
    }
    sendBtn = el("button", "s", "Send");
    sendBtn.type = "submit";
    form.appendChild(input);
    form.appendChild(sendBtn);
    form.onsubmit = function (e) { e.preventDefault(); send(); };

    pre = null;
    var signed = opts.user && opts.user.id && opts.user.hash;
    var askEmail = c.askEmail || (offline && c.offlineAskEmail);
    if (!state.token && !signed && (c.askName || askEmail)) {
      pre = el("div", "pre");
      if (offline && c.offlineAskEmail) pre.appendChild(el("p", null, "Leave your email so we can reply when we're back."));
      if (c.askName) { var n = el("input"); n.placeholder = "Your name (optional)"; n.maxLength = 80; n.setAttribute("aria-label", "Your name"); n.dataset.f = "name"; pre.appendChild(n); }
      if (askEmail) { var m = el("input"); m.type = "email"; m.placeholder = "Your email" + (offline && c.offlineAskEmail ? "" : " (optional)"); m.maxLength = 120; m.setAttribute("aria-label", "Your email"); m.dataset.f = "email"; pre.appendChild(m); }
    }
    panel.appendChild(head);
    panel.appendChild(list);
    panel.appendChild(typingEl);
    panel.appendChild(note);
    if (pre) panel.appendChild(pre);
    panel.appendChild(form);
    shadow.appendChild(panel);
    shadow.appendChild(wrap);
    document.body.appendChild(root);
    if (!state.cfg.enabled) { input.disabled = true; sendBtn.disabled = true; if (attachBtn) attachBtn.disabled = true; note.textContent = "Chat is not available right now."; }
    document.addEventListener("visibilitychange", function () { if (visible()) poll(); });
    render();
    if (state.token) poll();
    schedule();
  }

  var savedOverflow = null;
  function toggle(open) {
    state.open = open;
    panel.className = open ? "p o" : "p";
    // On a phone the panel covers the page: stop the page scrolling underneath it.
    if (window.matchMedia && window.matchMedia("(max-width:480px)").matches) {
      if (open) { savedOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = "hidden"; }
      else if (savedOverflow !== null) { document.documentElement.style.overflow = savedOverflow; savedOverflow = null; }
    }
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

  function typing() {
    if (!state.token || Date.now() - state.typingSent < 3000) return;
    state.typingSent = Date.now();
    api("/typing", { method: "POST", body: "{}" }).catch(function () {});
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
      return api("/messages", { method: "POST", body: JSON.stringify({ text: text, nonce: n, pageUrl: location.href }) });
    }).catch(function (err) {
      state.pending = state.pending.filter(function (p) { return p.nonce !== n; });
      input.value = text;
      note.textContent = err.message || "Not sent. Try again.";
      render();
    });
  }

  function upload(file) {
    if (state.uploading) return;
    if (file.size > 10 * 1024 * 1024) { note.textContent = "Files can be at most 10 MB."; return; }
    state.uploading = true;
    attachBtn.disabled = true;
    note.textContent = "Sending " + file.name + "…";
    ensureSession().then(function () {
      var fd = new FormData();
      fd.append("file", file);
      fd.append("pageUrl", location.href);
      return api("/files", { method: "POST", body: fd });
    }).then(function () { note.textContent = ""; poll(); }).catch(function (err) {
      note.textContent = err.message || "The file was not sent. Try again.";
    }).finally(function () { state.uploading = false; attachBtn.disabled = false; });
  }

  function poll() {
    if (!state.token) return;
    var q = [];
    if (state.last) q.push("after=" + encodeURIComponent(state.last));
    if (visible()) q.push("seen=1");
    api("/messages" + (q.length ? "?" + q.join("&") : ""), { method: "GET" }).then(function (r) {
      var fresh = r.messages || [];
      fresh.forEach(function (m) {
        if (state.messages.some(function (x) { return x.id === m.id; })) return;
        state.messages.push(m);
        if (m.nonce) state.pending = state.pending.filter(function (p) { return p.nonce !== m.nonce; });
        if (m.from !== "visitor" && !visible()) state.unread++;
        state.last = m.at;
      });
      var wasTyping = state.agentTyping;
      state.agentTyping = Boolean(r.agentTyping);
      if (fresh.length || wasTyping !== state.agentTyping) render();
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
      var b = el("div", "m " + (m.from === "visitor" ? "v" : "t"), m.text || null);
      (m.files || []).forEach(function (f) { b.appendChild(el("span", "file", "📎 " + f)); });
      list.appendChild(b);
    });
    state.pending.forEach(function (p) { list.appendChild(el("div", "m v pend", p.text)); });
    typingEl.textContent = state.agentTyping ? (state.cfg.name + " is typing…") : "";
    list.scrollTop = list.scrollHeight;
  }
})();`;
