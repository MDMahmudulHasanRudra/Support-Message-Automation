import { WIDGET_FONT_STACKS, widgetPathAllowed, widgetTeaserAllowed } from "@support-automation/shared";

/**
 * The embeddable website chat widget (WEBSITE_CHAT.md, Website Chat V3), served as plain JavaScript by
 * /api/webchat/widget.js. No framework, no third-party code, one file. The embed line never changes:
 *
 *   <script src="https://<this app>/api/webchat/widget.js" data-key="<widget key>" async></script>
 *
 * Optional, before it: window.GetAssistChat = { user: { id, name, email, phone, hash, phoneHash } } where the hashes
 * are HMAC-SHA256 computed on the site's SERVER — never in the browser. After it loads, the same object also gets
 * open(), close() and destroy().
 *
 * Safety: everything renders inside a closed Shadow DOM; every message is set with textContent (never HTML), so
 * nothing a visitor or agent types can run on the host page. The token is kept in localStorage per widget key and
 * sent as a bearer header; it only ever reads its own conversation. Photos are fetched with that token and shown as
 * blob: addresses — there is no public address for a visitor's file. The page address is reduced to origin + path
 * by the server. Page targeting and the greeting's frequency rules are the shared functions themselves
 * (packages/shared webchat.ts), embedded as source, so the browser runs exactly what the tests check.
 *
 * Preview (`data-preview="1"`, the settings page only): no network at all. The configuration and sample messages come
 * from window.GetAssistChatPreview and from postMessage by the parent page; nothing is sent, no visitor is created.
 */
const VERSION = "3.0.0";

export const WIDGET_SCRIPT = String.raw`(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  var preview = script.getAttribute("data-preview") === "1";
  if (!preview && window.__getAssistChatLoaded) return;
  window.__getAssistChatLoaded = true;
  var key = script.getAttribute("data-key");
  if (!key) return;
  var VERSION = "` + VERSION + String.raw`";
  var base = new URL(script.src, location.href).origin + "/api/webchat/" + encodeURIComponent(key);
  var storeKey = "getassist-chat-" + key;
  var opts = window.GetAssistChat || (window.GetAssistChat = {});
  var pathAllowed = ` + widgetPathAllowed.toString() + String.raw`;
  var teaserAllowed = ` + widgetTeaserAllowed.toString() + String.raw`;
  var FONTS = ` + JSON.stringify(WIDGET_FONT_STACKS) + String.raw`;
  var mqMobile = window.matchMedia ? window.matchMedia("(max-width:480px)") : { matches: false };
  var mqDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : { matches: false };
  var reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
  var touch = window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : false;
  var S = { token: null, open: false, msgs: [], pending: [], last: null, unread: 0, cfg: null, timer: null, starting: null, typingSent: 0, agentTyping: false, draft: null, failures: 0, shown: false, destroyed: false, userClosed: false, newBelow: false, view: null };
  var blobs = {};
  var timers = [];

  function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(storeKey + k) || "null"); localStorage.setItem(storeKey + k, JSON.stringify(v)); } catch (e) { return null; } }
  function session(k, v) { try { if (v === undefined) return sessionStorage.getItem(storeKey + k); sessionStorage.setItem(storeKey + k, v); } catch (e) { return null; } }
  function load() { var v = store("") || {}; S.token = v.token || null; }
  function save() { store("", { token: S.token }); }
  function api(path, init) {
    if (preview) return Promise.reject(new Error("Preview: nothing is sent."));
    init = init || {};
    init.headers = init.headers || {};
    if (S.token) init.headers.Authorization = "Bearer " + S.token;
    if (init.body && typeof init.body === "string") init.headers["Content-Type"] = "application/json";
    return fetch(base + path, init).then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j && j.error || "Something went wrong."); e.status = r.status; throw e; } return j; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function nonce() { var a = new Uint8Array(12); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function hex(h, f) { return /^#[0-9a-f]{6}$/i.test(h || "") ? h : f; }
  function lum(h) { function ch(i) { var c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); } return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5); }
  function ink(h) { return lum(h) > 0.45 ? "#0f172a" : "#ffffff"; }
  function shade(h, amt) { var n = parseInt(h.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; function f(c) { return Math.max(0, Math.min(255, Math.round(c + amt))); } return "#" + ((1 << 24) + (f(r) << 16) + (f(g) << 8) + f(b)).toString(16).slice(1); }
  function svg(path, size) { var s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("width", size || 24); s.setAttribute("height", size || 24); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true"); path.split("|").forEach(function (d) { var p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.appendChild(p); }); return s; }
  var ICONS = {
    chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    message: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z",
    help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3|M12 17h.01",
    headset: "M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3",
    close: "M18 6 6 18|M6 6l12 12",
    minimize: "M6 9l6 6 6-6",
    send: "M22 2 11 13|M22 2 15 22l-4-9-9-4z",
    clip: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
    image: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z|M21 15l-5-5L5 21",
    smile: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M8 14s1.5 2 4 2 4-2 4-2|M9 9h.01|M15 9h.01",
    bot: "M12 8V4H8|M4 8h16v12H4z|M2 14h2|M20 14h2|M15 13v2|M9 13v2",
    down: "M12 5v14|M19 12l-7 7-7-7",
  };

  // ── Look ───────────────────────────────────────────────────────────────────────────────────────
  function palette(c) {
    var dark = c.theme === "dark" || (c.theme === "auto" && mqDark.matches);
    var brand = hex(c.color, "#2563eb");
    var surface = dark ? "#1f2229" : "#ffffff";
    var text = dark ? "#e8eaed" : "#0f172a";
    var head = c.headerStyle === "light" ? surface : hex(c.headerColor, brand);
    var vis = hex(c.visitorBubbleColor, brand);
    var team = hex(c.teamBubbleColor, surface);
    return {
      dark: dark, brand: brand, brandInk: ink(brand), surface: surface, text: text,
      muted: dark ? "#9aa0aa" : "#64748b", border: dark ? "#2f333c" : "#e2e8f0",
      bg: hex(c.backgroundColor, dark ? "#16181d" : "#f8fafc"),
      head: head, headInk: c.headerStyle === "light" ? text : ink(head),
      headBg: c.headerStyle === "gradient" ? "linear-gradient(135deg," + head + "," + shade(head, lum(head) > 0.45 ? -40 : 40) + ")" : head,
      vis: vis, visInk: ink(vis), team: team, teamInk: lum(team) > 0.45 ? "#0f172a" : "#f8fafc",
      shadow: c.shadow === "none" ? "none" : c.shadow === "strong" ? "0 18px 50px rgba(0,0,0,.32)" : "0 10px 32px rgba(0,0,0,.18)",
    };
  }
  function css(c, p, side) {
    var r = Math.max(0, Math.min(28, Number(c.radius) || 16));
    var size = Math.max(44, Math.min(72, Number(c.launcherSize) || 56));
    var w = Math.max(320, Math.min(440, Number(c.panelWidth) || 360));
    var h = Math.max(420, Math.min(720, Number(c.panelHeight) || 540));
    var font = FONTS[c.font] || FONTS.system;
    var anim = reduceMotion ? "" : "transition:opacity .18s ease,transform .18s ease;";
    return [
      ":host{all:initial}*{box-sizing:border-box;font-family:" + font + ";-webkit-font-smoothing:antialiased}",
      "button{font:inherit;color:inherit}",
      ".w{display:flex;align-items:flex-end;gap:10px;flex-direction:" + (side === "left" ? "row-reverse" : "row") + "}",
      ".lab{background:" + p.surface + ";color:" + p.text + ";border-radius:999px;padding:9px 15px;font-size:14px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.15);cursor:pointer;border:0;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".b{width:" + size + "px;height:" + size + "px;border-radius:50%;border:0;cursor:pointer;background:" + p.brand + ";color:" + p.brandInk + ";box-shadow:0 6px 20px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;position:relative;padding:0;" + (reduceMotion ? "" : "transition:transform .15s ease;") + "}",
      ".b:hover{" + (reduceMotion ? "" : "transform:scale(1.05)") + "}.b.txt{width:auto;border-radius:999px;padding:0 18px 0 14px;gap:8px;font-weight:600;font-size:14px;height:" + Math.max(44, size - 6) + "px}",
      ".b img.lg{width:100%;height:100%;border-radius:50%;object-fit:cover}.b img.ic{width:60%;height:60%;object-fit:contain}",
      ".stack{display:flex}.stack img,.stack .ini{width:" + Math.round(size * 0.62) + "px;height:" + Math.round(size * 0.62) + "px;border-radius:50%;border:2px solid " + p.brand + ";object-fit:cover;margin-left:-10px;background:" + p.surface + "}.stack :first-child{margin-left:0}",
      ".ini{display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:" + p.text + "}",
      "*:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}",
      ".badge{position:absolute;top:-3px;" + (side === "left" ? "left" : "right") + ":-3px;min-width:20px;height:20px;border-radius:10px;background:#dc2626;color:#fff;font-size:11px;font-weight:700;line-height:20px;text-align:center;padding:0 5px;display:none}",
      ".tz{position:absolute;bottom:" + (size + 14) + "px;" + side + ":0;max-width:260px;background:" + p.surface + ";color:" + p.text + ";border:1px solid " + p.border + ";border-radius:14px;padding:12px 32px 12px 14px;font-size:14px;line-height:1.4;box-shadow:0 8px 24px rgba(0,0,0,.16);cursor:pointer;" + anim + "}",
      ".tz.hide{opacity:0;transform:translateY(6px);pointer-events:none}.tz .x2{position:absolute;top:4px;right:4px;border:0;background:transparent;color:" + p.muted + ";cursor:pointer;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center}",
      ".p{position:absolute;bottom:" + (size + 14) + "px;" + side + ":0;width:" + w + "px;height:" + h + "px;max-height:calc(100vh - " + (size + 54) + "px);max-width:calc(100vw - 24px);background:" + p.bg + ";color:" + p.text + ";border-radius:" + r + "px;box-shadow:" + p.shadow + ";display:none;flex-direction:column;overflow:hidden;border:1px solid " + p.border + "}",
      ".p.o{display:flex}" + (reduceMotion ? "" : ".p.o{animation:pin .18s ease}@keyframes pin{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}"),
      ".h{background:" + p.headBg + ";color:" + p.headInk + ";padding:14px 12px 14px 16px;display:flex;align-items:center;gap:10px;" + (c.headerStyle === "light" ? "border-bottom:1px solid " + p.border + ";" : "") + "}",
      ".h .logo{width:36px;height:36px;border-radius:10px;object-fit:cover;background:#fff;flex:none}.h .stack img,.h .stack .ini{width:32px;height:32px;border-color:" + p.head + "}",
      ".h .t{min-width:0;flex:1}.h h2{margin:0;font-size:15px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.h p{margin:2px 0 0;font-size:12px;opacity:.88;line-height:1.35}",
      ".dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#22c55e;vertical-align:1px}.dot.off{background:#94a3b8}",
      ".x{background:transparent;border:0;color:" + p.headInk + ";cursor:pointer;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none}.x:hover{background:rgba(127,127,127,.18)}",
      ".rc{font-size:12px;text-align:center;padding:6px;background:#fef3c7;color:#92400e;display:none}.rc.on{display:block}",
      ".lw{flex:1;position:relative;min-height:0}.l{position:absolute;inset:0;overflow-y:auto;padding:14px 12px 8px;display:flex;flex-direction:column;gap:4px;overscroll-behavior:contain}",
      ".day{align-self:center;font-size:11px;color:" + p.muted + ";background:" + p.surface + ";border:1px solid " + p.border + ";border-radius:999px;padding:2px 10px;margin:8px 0 4px}",
      ".row{display:flex;flex-direction:column;max-width:82%}.row.v{align-self:flex-end;align-items:flex-end}.row.t{align-self:flex-start;align-items:flex-start}",
      ".a{font-size:11px;color:" + p.muted + ";margin:6px 4px 2px;display:flex;align-items:center;gap:4px}.ai{font-size:10px;font-weight:700;letter-spacing:.02em;padding:1px 6px;border-radius:6px;background:" + p.border + ";color:" + p.text + "}",
      ".m{padding:9px 12px;border-radius:" + Math.max(8, r - 2) + "px;font-size:14px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}",
      ".v .m{background:" + p.vis + ";color:" + p.visInk + ";border-bottom-right-radius:4px}.t .m{background:" + p.team + ";color:" + p.teamInk + ";border:1px solid " + p.border + ";border-bottom-left-radius:4px}",
      ".m img.ph{display:block;max-width:220px;max-height:220px;min-width:80px;min-height:60px;border-radius:8px;background:" + p.border + ";cursor:zoom-in;object-fit:cover}.m img.ph+span{display:block;margin-top:6px}",
      ".fl{display:inline-flex;align-items:center;gap:6px;font-size:13px;text-decoration:underline;cursor:pointer;background:transparent;border:0;color:inherit;padding:0}",
      ".tm{font-size:10.5px;color:" + p.muted + ";margin:2px 4px 0}.pend .m{opacity:.65}.fail .m{opacity:.85;outline:1px dashed #dc2626}",
      ".rt{font-size:11.5px;color:#dc2626;background:transparent;border:0;cursor:pointer;text-decoration:underline;padding:2px 4px}",
      ".ty{font-size:12px;color:" + p.muted + ";padding:2px 16px 6px;min-height:22px;display:flex;align-items:center;gap:6px}",
      ".ty i{display:inline-block;width:6px;height:6px;border-radius:50%;background:" + p.muted + ";" + (reduceMotion ? "" : "animation:bl 1.2s infinite") + "}.ty i:nth-child(2){animation-delay:.2s}.ty i:nth-child(3){animation-delay:.4s}@keyframes bl{0%,80%,100%{opacity:.3}40%{opacity:1}}",
      ".nb{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);border:0;border-radius:999px;background:" + p.brand + ";color:" + p.brandInk + ";font-size:12px;font-weight:600;padding:6px 12px;cursor:pointer;display:none;box-shadow:0 4px 12px rgba(0,0,0,.2);align-items:center;gap:4px}.nb.on{display:flex}",
      ".n{font-size:12px;color:#dc2626;padding:0 14px 6px}",
      ".dr{margin:0 10px 8px;display:flex;align-items:center;gap:10px;padding:8px;border:1px solid " + p.border + ";border-radius:12px;background:" + p.surface + "}.dr img{width:44px;height:44px;border-radius:8px;object-fit:cover}.dr .dn{flex:1;min-width:0;font-size:12px;color:" + p.muted + "}.dr .dn b{display:block;color:" + p.text + ";font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".bar{height:4px;border-radius:2px;background:" + p.border + ";margin-top:4px;overflow:hidden}.bar i{display:block;height:100%;background:" + p.brand + ";width:0}",
      ".f{display:flex;gap:4px;padding:8px 8px 10px;border-top:1px solid " + p.border + ";background:" + p.surface + ";align-items:flex-end}",
      ".f textarea{flex:1;resize:none;border:1px solid " + p.border + ";background:" + p.surface + ";color:" + p.text + ";border-radius:12px;padding:9px 11px;font-size:14px;line-height:1.4;max-height:120px;min-height:40px;outline:none}.f textarea:focus{border-color:" + p.brand + "}",
      ".ib{border:0;background:transparent;cursor:pointer;color:" + p.muted + ";border-radius:10px;width:38px;height:40px;display:flex;align-items:center;justify-content:center;flex:none}.ib:hover{background:" + p.border + "}",
      ".s{border:0;border-radius:12px;width:42px;height:40px;background:" + p.brand + ";color:" + p.brandInk + ";cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none}.s:disabled,.ib:disabled{opacity:.45;cursor:default}",
      ".cc{font-size:11px;color:" + p.muted + ";text-align:right;padding:0 12px 4px;display:none}.cc.on{display:block}.cc.over{color:#dc2626}",
      ".pre{padding:12px;display:flex;flex-direction:column;gap:8px;border-top:1px solid " + p.border + ";background:" + p.surface + "}.pre input{border:1px solid " + p.border + ";background:" + p.surface + ";color:" + p.text + ";border-radius:10px;padding:9px 11px;font-size:14px}.pre p{margin:0;font-size:12px;color:" + p.muted + "}",
      ".ep{position:absolute;bottom:58px;left:8px;right:8px;max-height:260px;background:" + p.surface + ";border:1px solid " + p.border + ";border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.2);display:none;flex-direction:column;overflow:hidden;z-index:2}.ep.on{display:flex}",
      ".ep input{margin:8px;border:1px solid " + p.border + ";background:" + p.surface + ";color:" + p.text + ";border-radius:8px;padding:7px 10px;font-size:13px}",
      ".et{display:flex;gap:2px;padding:0 8px;overflow-x:auto}.et button{border:0;background:transparent;font-size:12px;color:" + p.muted + ";padding:4px 8px;border-radius:8px;cursor:pointer;white-space:nowrap}.et button.on{background:" + p.border + ";color:" + p.text + "}",
      ".eg{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding:6px 8px 8px;overflow-y:auto}.eg button{border:0;background:transparent;font-size:22px;line-height:1;height:36px;border-radius:8px;cursor:pointer;font-family:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif}.eg button:hover,.eg button:focus{background:" + p.border + "}",
      ".dz{position:absolute;inset:0;background:rgba(37,99,235,.08);border:2px dashed " + p.brand + ";border-radius:" + r + "px;display:none;align-items:center;justify-content:center;font-weight:600;color:" + p.brand + ";z-index:3;pointer-events:none}.dz.on{display:flex}",
      ".lb{position:absolute;inset:0;background:rgba(0,0,0,.82);display:none;align-items:center;justify-content:center;z-index:4;cursor:zoom-out}.lb.on{display:flex}.lb img{max-width:94%;max-height:90%;border-radius:8px}",
      ".pv{font-size:11px;text-align:center;color:" + p.muted + ";padding:2px 8px 6px}",
      "@media (max-width:480px){" + (c.mobileFullscreen !== false
        ? ".p{position:fixed;inset:0;width:auto;height:100%;max-height:none;max-width:none;border-radius:0;border:0;padding-bottom:env(safe-area-inset-bottom)}"
        : ".p{position:fixed;left:8px;right:8px;bottom:" + (size + 24) + "px;width:auto;height:min(" + h + "px,calc(100vh - " + (size + 48) + "px))}") +
        ".f textarea,.pre input,.ep input{font-size:16px}.lab{display:none}.tz{max-width:calc(100vw - 100px)}}",
    ].join("");
  }

  // ── Building ───────────────────────────────────────────────────────────────────────────────────
  var root, shadow, panel, list, listWrap, input, sendBtn, attachBtn, emojiBtn, fileInput, bubble, badge, form, note, pre, typingEl, teaserEl, newBtn, draftEl, recon, counter, picker, dropZone, lightbox;
  function asset(u) { return u ? (/^https?:/.test(u) ? u : base + "/" + u) : null; }
  function initials(name) { return (name || "?").split(/\s+/).map(function (w) { return w.charAt(0); }).join("").slice(0, 2).toUpperCase(); }
  function avatarStack(team, max) {
    var st = el("div", "stack");
    team.slice(0, max).forEach(function (m) {
      var img = el("img"); img.alt = ""; img.src = asset(m.avatarUrl);
      img.onerror = function () { var f = el("span", "ini", initials(m.name)); img.replaceWith(f); };
      st.appendChild(img);
    });
    return st;
  }
  function build() {
    var c = S.cfg.settings;
    var p = palette(c);
    var offline = S.cfg.availability && !S.cfg.availability.open;
    var side = c.position === "left" ? "left" : "right";
    root = document.createElement("div");
    root.setAttribute("data-getassist-chat", VERSION);
    root.style.cssText = "position:fixed;z-index:2147483000;bottom:" + (Number(c.bottomOffset) || 20) + "px;" + side + ":20px;" + (S.shown || preview ? "" : "display:none");
    shadow = root.attachShadow({ mode: "closed" });
    var style = el("style"); style.textContent = css(c, p, side); shadow.appendChild(style);

    // Launcher
    var wrap = el("div", "w");
    bubble = el("button", "b");
    bubble.setAttribute("aria-label", "Open chat: " + c.title);
    bubble.setAttribute("aria-expanded", "false");
    var style2 = c.launcherStyle || "ICON";
    var icon = function () { return svg(ICONS[c.launcherIcon] || ICONS.chat, Math.round((Number(c.launcherSize) || 56) * 0.45)); };
    if (style2 === "LOGO" && c.logoUrl) { var lg = el("img", "lg"); lg.alt = ""; lg.src = asset(c.logoUrl); lg.onerror = function () { lg.replaceWith(icon()); }; bubble.appendChild(lg); }
    else if (style2 === "CUSTOM_ICON" && c.launcherIconUrl) { var ic = el("img", "ic"); ic.alt = ""; ic.src = asset(c.launcherIconUrl); ic.onerror = function () { ic.replaceWith(icon()); }; bubble.appendChild(ic); }
    else if (style2 === "AVATAR" && c.team && c.team.length) { bubble.appendChild(avatarStack(c.team, 3)); bubble.style.background = "transparent"; bubble.style.boxShadow = "none"; bubble.style.width = "auto"; }
    else if (style2 === "ICON_TEXT") { bubble.className = "b txt"; bubble.appendChild(icon()); bubble.appendChild(el("span", null, c.launcherLabel || c.title)); }
    else bubble.appendChild(icon());
    badge = el("span", "badge"); badge.setAttribute("aria-hidden", "true"); bubble.appendChild(badge);
    bubble.onclick = function () { toggle(!S.open); };
    if (c.launcherLabel && style2 === "ICON") { var lab = el("button", "lab", c.launcherLabel); lab.onclick = function () { toggle(true); }; wrap.appendChild(lab); }
    wrap.appendChild(bubble);

    teaserEl = el("div", "tz hide");
    teaserEl.setAttribute("role", "status");
    var tzText = el("span", null, c.teaser && c.teaser.text || "");
    var tzClose = el("button", "x2"); tzClose.appendChild(svg(ICONS.close, 14)); tzClose.setAttribute("aria-label", "Dismiss");
    tzClose.onclick = function (e) { e.stopPropagation(); dismissTeaser(); };
    teaserEl.appendChild(tzText); teaserEl.appendChild(tzClose);
    teaserEl.onclick = function () { toggle(true); };

    // Panel
    panel = el("div", "p");
    panel.id = "getassist-chat-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", c.title);
    bubble.setAttribute("aria-controls", panel.id);
    var head = el("div", "h");
    if (c.headerVisual === "LOGO" && c.logoUrl) { var hl = el("img", "logo"); hl.alt = ""; hl.src = asset(c.logoUrl); hl.onerror = function () { hl.remove(); }; head.appendChild(hl); }
    else if (c.headerVisual === "AVATARS" && c.team && c.team.length) head.appendChild(avatarStack(c.team, 3));
    var titles = el("div", "t");
    titles.appendChild(el("h2", null, c.title));
    var sub = el("p");
    sub.appendChild(el("span", offline ? "dot off" : "dot"));
    var teamNames = c.headerVisual === "AVATARS" && c.team && c.team.length ? c.team.slice(0, 3).map(function (m) { return m.name; }).join(", ") + " · " : "";
    sub.appendChild(document.createTextNode(offline ? (c.offlineMessage + (S.cfg.availability.nextOpen ? " Back " + S.cfg.availability.nextOpen + "." : "")) : (teamNames + (c.replyNote || "We're here to help"))));
    titles.appendChild(sub);
    head.appendChild(titles);
    var close = el("button", "x"); close.appendChild(svg(ICONS.minimize, 20)); close.setAttribute("aria-label", "Minimise chat");
    close.onclick = function () { S.userClosed = true; toggle(false); };
    head.appendChild(close);
    recon = el("div", "rc", "Reconnecting…");
    listWrap = el("div", "lw");
    list = el("div", "l");
    list.setAttribute("role", "log");
    list.setAttribute("aria-live", "polite");
    list.setAttribute("aria-label", "Conversation");
    list.onscroll = function () { if (atBottom()) { S.newBelow = false; newBtn.className = "nb"; } };
    newBtn = el("button", "nb"); newBtn.appendChild(svg(ICONS.down, 14)); newBtn.appendChild(document.createTextNode("New messages"));
    newBtn.onclick = function () { list.scrollTop = list.scrollHeight; S.newBelow = false; newBtn.className = "nb"; };
    dropZone = el("div", "dz", "Drop a photo to send");
    lightbox = el("div", "lb"); lightbox.setAttribute("role", "dialog"); lightbox.setAttribute("aria-label", "Photo");
    lightbox.onclick = function () { lightbox.className = "lb"; lightbox.textContent = ""; };
    listWrap.appendChild(list); listWrap.appendChild(newBtn);
    typingEl = el("div", "ty"); typingEl.setAttribute("aria-live", "polite");
    note = el("div", "n"); note.setAttribute("role", "alert");
    draftEl = el("div"); counter = el("div", "cc");
    form = el("form", "f");
    input = el("textarea");
    input.rows = 1; input.maxLength = 2000;
    input.placeholder = "Write a message…";
    input.setAttribute("aria-label", "Message");
    input.onkeydown = function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch) { e.preventDefault(); send(); }
      if (e.key === "Escape") { if (picker && picker.className.indexOf("on") > -1) closePicker(); else { S.userClosed = true; toggle(false); } }
    };
    input.oninput = function () { grow(); typing(); count(); };
    input.onpaste = function (e) { if (!c.allowAttachments || !e.clipboardData) return; var f = Array.prototype.find.call(e.clipboardData.files || [], function (x) { return /^image\//.test(x.type); }); if (f) { e.preventDefault(); choose(f); } };
    if (c.emoji !== false) {
      emojiBtn = el("button", "ib"); emojiBtn.type = "button"; emojiBtn.setAttribute("aria-label", "Insert an emoji"); emojiBtn.setAttribute("aria-haspopup", "true"); emojiBtn.appendChild(svg(ICONS.smile, 20));
      emojiBtn.onclick = function () { if (picker && picker.className.indexOf("on") > -1) closePicker(); else openPicker(); };
      form.appendChild(emojiBtn);
    }
    if (c.allowAttachments) {
      attachBtn = el("button", "ib"); attachBtn.type = "button"; attachBtn.setAttribute("aria-label", c.allowPdf ? "Send a photo or PDF" : "Send a photo"); attachBtn.appendChild(svg(ICONS.image, 20));
      fileInput = el("input"); fileInput.type = "file"; fileInput.accept = "image/jpeg,image/png,image/webp" + (c.allowPdf ? ",application/pdf" : ""); fileInput.style.display = "none";
      fileInput.onchange = function () { if (fileInput.files && fileInput.files[0]) choose(fileInput.files[0]); fileInput.value = ""; };
      attachBtn.onclick = function () { fileInput.click(); };
      form.appendChild(attachBtn); form.appendChild(fileInput);
      panel.addEventListener("dragover", function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") > -1) { e.preventDefault(); dropZone.className = "dz on"; } });
      panel.addEventListener("dragleave", function (e) { if (e.target === panel || !panel.contains(e.relatedTarget)) dropZone.className = "dz"; });
      panel.addEventListener("drop", function (e) { e.preventDefault(); dropZone.className = "dz"; var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) choose(f); });
    }
    sendBtn = el("button", "s"); sendBtn.type = "submit"; sendBtn.setAttribute("aria-label", "Send"); sendBtn.appendChild(svg(ICONS.send, 18));
    form.appendChild(input);
    form.appendChild(sendBtn);
    form.onsubmit = function (e) { e.preventDefault(); send(); };

    pre = null;
    var signed = opts.user && opts.user.id && opts.user.hash;
    var askEmail = c.askEmail || (offline && c.offlineAskEmail);
    if (!S.token && !signed && (c.askName || askEmail) && !preview) {
      pre = el("div", "pre");
      if (offline && c.offlineAskEmail) pre.appendChild(el("p", null, "Leave your email so we can reply when we're back."));
      if (c.askName) { var n = el("input"); n.placeholder = "Your name (optional)"; n.maxLength = 80; n.setAttribute("aria-label", "Your name"); n.dataset.f = "name"; n.autocomplete = "name"; pre.appendChild(n); }
      if (askEmail) { var m = el("input"); m.type = "email"; m.placeholder = "Your email" + (offline && c.offlineAskEmail ? "" : " (optional)"); m.maxLength = 120; m.setAttribute("aria-label", "Your email"); m.dataset.f = "email"; m.autocomplete = "email"; pre.appendChild(m); }
    }
    panel.appendChild(head);
    panel.appendChild(recon);
    panel.appendChild(listWrap);
    panel.appendChild(typingEl);
    panel.appendChild(note);
    panel.appendChild(draftEl);
    if (pre) panel.appendChild(pre);
    panel.appendChild(counter);
    if (preview) panel.appendChild(el("div", "pv", "Preview — nothing is sent"));
    panel.appendChild(form);
    panel.appendChild(dropZone);
    panel.appendChild(lightbox);
    panel.addEventListener("keydown", function (e) { if (e.key === "Escape" && lightbox.className.indexOf("on") > -1) { lightbox.className = "lb"; lightbox.textContent = ""; } });
    shadow.appendChild(panel);
    shadow.appendChild(teaserEl);
    shadow.appendChild(wrap);
    (document.body || document.documentElement).appendChild(root);
    if (!S.cfg.enabled) { input.disabled = true; sendBtn.disabled = true; if (attachBtn) attachBtn.disabled = true; note.textContent = "Chat is not available right now."; }
    render(true);
  }

  // ── Behaviour ──────────────────────────────────────────────────────────────────────────────────
  function grow() { input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight) + "px"; }
  function count() { var n = input.value.length; counter.textContent = n + " / 2000"; counter.className = n > 1800 ? (n >= 2000 ? "cc on over" : "cc on") : "cc"; }
  function atBottom() { return !list || list.scrollHeight - list.scrollTop - list.clientHeight < 48; }
  function here() {
    var c = S.cfg.settings;
    var mobile = mqMobile.matches;
    if (mobile && c.devices && c.devices.mobile === false) return false;
    if (!mobile && c.devices && c.devices.desktop === false) return false;
    return !c.pages || pathAllowed(location.pathname, c.pages);
  }
  function applyVisibility() {
    if (!root || preview) return;
    var ok = S.open || here();
    root.style.display = ok && S.shown ? "" : "none";
  }

  var savedOverflow = null;
  function toggle(open, how) {
    if (!panel) return;
    S.open = open;
    panel.className = open ? "p o" : "p";
    bubble.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) hideTeaser();
    if (!preview && mqMobile.matches && S.cfg.settings.mobileFullscreen !== false) {
      if (open) { savedOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = "hidden"; }
      else if (savedOverflow !== null) { document.documentElement.style.overflow = savedOverflow; savedOverflow = null; }
    }
    if (open) { S.unread = 0; render(true); if (!touch && !(how && how.auto)) input.focus(); poll(); }
    else if (!(how && how.silent)) bubble.focus();
    if (!open) closePicker();
    applyVisibility();
    schedule();
  }

  function schedule() {
    clearTimeout(S.timer);
    if (!S.token || preview || S.destroyed) return;
    if (document.visibilityState === "hidden") return;
    var wait = S.open ? 3000 : 30000;
    if (S.failures) wait = Math.min(60000, 3000 * Math.pow(2, S.failures));
    S.timer = setTimeout(function () { poll(); schedule(); }, wait);
  }

  function ensureSession() {
    if (S.token) return Promise.resolve();
    if (S.starting) return S.starting;
    var body = { identity: opts.user || null };
    if (pre) Array.prototype.forEach.call(pre.querySelectorAll("input"), function (i) { body[i.dataset.f] = i.value; });
    S.starting = api("/session", { method: "POST", body: JSON.stringify(body) }).then(function (r) {
      S.token = r.token; save(); if (pre) { pre.remove(); pre = null; } hideTeaser(); schedule();
    }).finally(function () { S.starting = null; });
    return S.starting;
  }

  function typing() {
    if (!S.token || preview || Date.now() - S.typingSent < 3000) return;
    S.typingSent = Date.now();
    api("/typing", { method: "POST", body: "{}" }).catch(function () {});
  }

  function send() {
    if (sendBtn.disabled) return;
    if (S.draft) return upload();
    var text = input.value.trim();
    if (!text) return;
    if (text.length > 2000) { note.textContent = "Messages can be at most 2000 characters."; return; }
    var item = { nonce: nonce(), text: text, at: new Date().toISOString(), failed: false };
    S.pending.push(item);
    input.value = ""; grow(); count();
    note.textContent = "";
    render(true);
    deliver(item);
  }
  function deliver(item) {
    item.failed = false;
    if (preview) { later(function () { S.pending = S.pending.filter(function (p) { return p !== item; }); S.msgs.push({ id: "pv" + Date.now(), from: "visitor", text: item.text, at: item.at, attachments: [] }); render(true); }, 300); return; }
    ensureSession().then(function () {
      return api("/messages", { method: "POST", body: JSON.stringify({ text: item.text, nonce: item.nonce, pageUrl: location.href }) });
    }).then(function () { poll(); }).catch(function (err) {
      item.failed = true; item.error = err.message || "Not sent.";
      render(false);
    });
  }

  // ── Photos ─────────────────────────────────────────────────────────────────────────────────────
  function choose(file) {
    var c = S.cfg.settings;
    var okType = /^image\/(jpeg|png|webp)$/.test(file.type) || (c.allowPdf && file.type === "application/pdf");
    if (!okType) { note.textContent = c.allowPdf ? "Only photos (JPEG, PNG, WebP) and PDFs can be sent." : "Only photos (JPEG, PNG or WebP) can be sent."; return; }
    if (file.size > 10 * 1024 * 1024) { note.textContent = "Photos can be at most 10 MB."; return; }
    clearDraft();
    S.draft = { file: file, url: /^image\//.test(file.type) ? URL.createObjectURL(file) : null, nonce: nonce(), progress: 0, state: "ready", error: null };
    note.textContent = "";
    drawDraft();
    input.placeholder = "Add a caption (optional)…";
    input.focus();
  }
  function clearDraft() { if (S.draft && S.draft.url) URL.revokeObjectURL(S.draft.url); S.draft = null; draftEl.textContent = ""; draftEl.className = ""; if (input) input.placeholder = "Write a message…"; }
  function drawDraft() {
    draftEl.textContent = "";
    var d = S.draft; if (!d) return;
    draftEl.className = "dr";
    if (d.url) { var img = el("img"); img.alt = ""; img.src = d.url; draftEl.appendChild(img); } else draftEl.appendChild(svg(ICONS.clip, 22));
    var info = el("div", "dn");
    info.appendChild(el("b", null, d.file.name || "photo"));
    info.appendChild(document.createTextNode(d.state === "uploading" ? "Sending… " + Math.round(d.progress * 100) + "%" : d.state === "failed" ? (d.error || "Not sent.") : Math.max(1, Math.round(d.file.size / 1024)) + " KB"));
    if (d.state === "uploading") { var bar = el("div", "bar"); var i = el("i"); i.style.width = Math.round(d.progress * 100) + "%"; bar.appendChild(i); info.appendChild(bar); }
    draftEl.appendChild(info);
    if (d.state === "failed") { var rt = el("button", "rt", "Retry"); rt.type = "button"; rt.onclick = upload; draftEl.appendChild(rt); }
    if (d.state !== "uploading") { var rm = el("button", "ib"); rm.type = "button"; rm.setAttribute("aria-label", "Remove the photo"); rm.appendChild(svg(ICONS.close, 16)); rm.onclick = clearDraft; draftEl.appendChild(rm); }
  }
  function upload() {
    var d = S.draft; if (!d || d.state === "uploading") return;
    if (preview) { var text = input.value.trim(); S.msgs.push({ id: "pv" + Date.now(), from: "visitor", text: text, at: new Date().toISOString(), attachments: [{ index: 0, type: "IMAGE", name: d.file.name, local: d.url }] }); S.draft = null; draftEl.textContent = ""; draftEl.className = ""; input.value = ""; render(true); return; }
    d.state = "uploading"; d.progress = 0; d.caption = input.value.trim(); drawDraft();
    ensureSession().then(function () {
      return new Promise(function (resolve, reject) {
        var fd = new FormData();
        fd.append("file", d.file); fd.append("text", d.caption); fd.append("nonce", d.nonce); fd.append("pageUrl", location.href);
        var x = new XMLHttpRequest();
        x.open("POST", base + "/files");
        x.setRequestHeader("Authorization", "Bearer " + S.token);
        x.upload.onprogress = function (e) { if (e.lengthComputable) { d.progress = e.loaded / e.total; drawDraft(); } };
        x.onload = function () { var j = null; try { j = JSON.parse(x.responseText); } catch (e) {} if (x.status >= 200 && x.status < 300) resolve(j); else reject(new Error(j && j.error || "The photo was not sent.")); };
        x.onerror = function () { reject(new Error("No connection. The photo was not sent.")); };
        x.send(fd);
      });
    }).then(function () {
      if (d.url) blobs["local:" + d.nonce] = d.url;
      S.draft = null; draftEl.textContent = ""; draftEl.className = ""; input.value = ""; grow(); count(); input.placeholder = "Write a message…"; poll();
    }).catch(function (err) { d.state = "failed"; d.error = err.message; drawDraft(); });
  }
  function showImage(m, a, img) {
    if (a.local) { img.src = a.local; return; }
    var k = m.id + ":" + a.index;
    if (blobs[k]) { img.src = blobs[k]; return; }
    if (preview) { img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='220' height='150'><rect width='220' height='150' fill='#cbd5e1'/><circle cx='70' cy='55' r='18' fill='#f8fafc'/><path d='M0 150 L80 80 L130 120 L170 90 L220 140 L220 150Z' fill='#94a3b8'/></svg>"); return; }
    fetch(base + "/media/" + encodeURIComponent(m.id) + "/" + a.index, { headers: { Authorization: "Bearer " + S.token } })
      .then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
      .then(function (b) { blobs[k] = URL.createObjectURL(b); img.src = blobs[k]; })
      .catch(function () { img.replaceWith(el("span", null, "Photo unavailable")); });
  }
  function openFile(m, a) {
    fetch(base + "/media/" + encodeURIComponent(m.id) + "/" + a.index, { headers: { Authorization: "Bearer " + S.token } })
      .then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
      .then(function (b) { var u = URL.createObjectURL(b); var link = document.createElement("a"); link.href = u; link.download = a.name || "file.pdf"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 10000); })
      .catch(function () { note.textContent = "The file could not be opened."; });
  }

  // ── Emoji ──────────────────────────────────────────────────────────────────────────────────────
  var EMOJI = {
    Smileys: "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😌 😍 🥰 😘 😋 😛 😜 🤪 🤗 🤭 🤔 😐 😏 🙄 😬 😮 😲 😳 🥺 😢 😭 😤 😠 😡 😱 😨 😥 😓 🤒 🤕 🤢 😴 🥳 😎 🤓",
    Gestures: "👍 👎 👌 ✌️ 🤞 🤟 🤘 👏 🙌 🤲 🙏 🤝 💪 👋 ✋ 👆 👇 👈 👉 ☝️ ✍️",
    Hearts: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝",
    Things: "🎉 🎊 🎁 🔥 ⭐ 🌟 ✨ ⚡ 💯 ✅ ❌ ❓ ❗ 💡 📦 🚚 🛒 💳 💰 📱 💻 📞 📧 📍 ⏰ 📅 🔒 🔑 🏠 🎯 🚀 ☕ 🍰 🌹 🌙 ☀️",
  };
  var WORDS = { happy: "😀😃😄😁😊🙂🥳", laugh: "😂🤣😆😅", love: "❤️😍🥰😘💕💖", heart: "❤️🧡💛💚💙💜💔💕", sad: "😢😭🥺😥😓💔", angry: "😠😡😤", thanks: "🙏🤝👍❤️", ok: "👌👍✅", yes: "👍✅👌", no: "👎❌", party: "🎉🎊🥳🎁", fire: "🔥", star: "⭐🌟✨", money: "💰💳", phone: "📱📞", time: "⏰📅", cool: "😎", think: "🤔", wave: "👋", clap: "👏", pray: "🙏", delivery: "📦🚚", shop: "🛒💳🎁" };
  function split(s) { return s.split(" ").filter(Boolean); }
  function chars(s) { var out = []; var re = /(\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*)/gu; var m; while ((m = re.exec(s))) out.push(m[0]); return out; }
  function recent() { var r = store("-emoji"); return Array.isArray(r) ? r.slice(0, 16) : []; }
  function openPicker() {
    if (!picker) {
      picker = el("div", "ep"); picker.setAttribute("role", "dialog"); picker.setAttribute("aria-label", "Emoji");
      var search = el("input"); search.type = "search"; search.placeholder = "Search emoji"; search.setAttribute("aria-label", "Search emoji");
      var tabs = el("div", "et"); var grid = el("div", "eg"); grid.setAttribute("role", "grid");
      var cats = ["Recent"].concat(Object.keys(EMOJI));
      function show(list) {
        grid.textContent = "";
        list.forEach(function (e, i) { var b = el("button", null, e); b.type = "button"; b.setAttribute("aria-label", e); b.tabIndex = i === 0 ? 0 : -1; b.onclick = function () { insert(e); }; grid.appendChild(b); });
        if (!list.length) grid.appendChild(el("span", null, "Nothing here yet"));
      }
      function tab(name) {
        Array.prototype.forEach.call(tabs.children, function (t) { t.className = t.textContent === name ? "on" : ""; });
        show(name === "Recent" ? recent() : split(EMOJI[name]));
      }
      cats.forEach(function (name) { var t = el("button", null, name); t.type = "button"; t.onclick = function () { search.value = ""; tab(name); }; tabs.appendChild(t); });
      search.oninput = function () {
        var q = search.value.trim().toLowerCase();
        if (!q) return tab(recent().length ? "Recent" : "Smileys");
        var found = [];
        Object.keys(WORDS).forEach(function (w) { if (w.indexOf(q) === 0) chars(WORDS[w]).forEach(function (e) { if (found.indexOf(e) < 0) found.push(e); }); });
        show(found);
      };
      search.onkeydown = function (e) { if (e.key === "ArrowDown") { e.preventDefault(); var f = grid.querySelector("button"); if (f) f.focus(); } if (e.key === "Escape") { e.preventDefault(); closePicker(); } };
      grid.onkeydown = function (e) {
        var items = Array.prototype.slice.call(grid.querySelectorAll("button")); var i = items.indexOf(shadow.activeElement); if (i < 0) return;
        var to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowDown" ? i + 8 : e.key === "ArrowUp" ? i - 8 : null;
        if (e.key === "Escape") { e.preventDefault(); closePicker(); return; }
        if (to === null) return;
        e.preventDefault(); if (to < 0) { search.focus(); return; } if (items[to]) items[to].focus();
      };
      picker.appendChild(search); picker.appendChild(tabs); picker.appendChild(grid);
      panel.appendChild(picker);
      picker.__tab = tab;
    }
    picker.className = "ep on";
    picker.__tab(recent().length ? "Recent" : "Smileys");
    emojiBtn.setAttribute("aria-expanded", "true");
    var s = picker.querySelector("input"); if (s && !touch) s.focus();
  }
  function closePicker() { if (!picker) return; picker.className = "ep"; if (emojiBtn) emojiBtn.setAttribute("aria-expanded", "false"); }
  function insert(e) {
    var start = input.selectionStart == null ? input.value.length : input.selectionStart;
    var end = input.selectionEnd == null ? start : input.selectionEnd;
    if (input.value.length + e.length > 2000) return;
    input.setRangeText(e, start, end, "end");
    var r = recent().filter(function (x) { return x !== e; }); r.unshift(e); store("-emoji", r.slice(0, 16));
    closePicker(); input.focus(); grow(); count(); typing();
  }

  // ── Greeting teaser and auto-open ──────────────────────────────────────────────────────────────
  function teaserMemory() { var m = store("-teaser") || {}; return { shownAt: m.shownAt || null, dismissedAt: m.dismissedAt || null, shownThisSession: session("-teaser") === "1" }; }
  function showTeaser(force) {
    var t = S.cfg.settings.teaser; if (!t || !t.text || !teaserEl) return;
    if (!force && !teaserAllowed(t, teaserMemory(), { now: Date.now(), mobile: mqMobile.matches, hasConversation: Boolean(S.token) || S.msgs.length > 0, panelOpen: S.open })) return;
    teaserEl.className = "tz";
    if (!preview) { var m = store("-teaser") || {}; m.shownAt = Date.now(); store("-teaser", m); session("-teaser", "1"); }
    if (t.hideAfterSec > 0 && !preview) later(hideTeaser, t.hideAfterSec * 1000);
  }
  function hideTeaser() { if (teaserEl) teaserEl.className = "tz hide"; }
  function dismissTeaser() { hideTeaser(); if (!preview) { var m = store("-teaser") || {}; m.dismissedAt = Date.now(); store("-teaser", m); } }
  function startTimers() {
    var c = S.cfg.settings;
    later(function () { S.shown = true; applyVisibility(); }, Math.max(0, Number(c.showDelaySec) || 0) * 1000);
    if (c.teaser && c.teaser.enabled) later(function () { if (here()) showTeaser(false); }, (Math.max(0, Number(c.showDelaySec) || 0) + Math.max(0, Number(c.teaser.delaySec) || 0)) * 1000);
    // Opening by itself is opt-in, never on a phone (it would cover the page), and at most once a browser session.
    if (c.autoOpen && c.autoOpen.enabled && !mqMobile.matches && !session("-autoopen")) {
      later(function () { if (!S.open && !S.userClosed && here() && S.cfg.enabled) { session("-autoopen", "1"); toggle(true, { auto: true }); } }, Math.max(5, Number(c.autoOpen.delaySec) || 30) * 1000);
    }
  }

  // ── Conversation ───────────────────────────────────────────────────────────────────────────────
  function poll() {
    if (!S.token || preview) return;
    var q = [];
    if (S.last) q.push("after=" + encodeURIComponent(S.last));
    if (S.open && document.visibilityState === "visible") q.push("seen=1");
    api("/messages" + (q.length ? "?" + q.join("&") : ""), { method: "GET" }).then(function (r) {
      if (S.failures) { S.failures = 0; recon.className = "rc"; }
      var fresh = r.messages || [];
      var teamNew = false;
      fresh.forEach(function (m) {
        if (S.msgs.some(function (x) { return x.id === m.id; })) return;
        S.msgs.push(m);
        if (m.nonce) S.pending = S.pending.filter(function (p) { return p.nonce !== m.nonce; });
        if (m.from !== "visitor") { teamNew = true; if (!(S.open && document.visibilityState === "visible")) S.unread++; }
        S.last = m.at;
      });
      var wasTyping = S.agentTyping;
      S.agentTyping = Boolean(r.agentTyping);
      if (fresh.length) render(false, teamNew);
      else if (wasTyping !== S.agentTyping) drawTyping();
    }).catch(function (err) {
      if (err && (err.status === 401 || err.status === 404) && /expired|not found/i.test(err.message)) { S.token = null; save(); return; }
      S.failures = Math.min(5, S.failures + 1);
      if (recon) recon.className = "rc on";
    });
  }

  function dayLabel(d) {
    var today = new Date(); var y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  }
  function timeLabel(d) { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function drawTyping() {
    typingEl.textContent = "";
    if (!S.agentTyping) return;
    typingEl.appendChild(el("i")); typingEl.appendChild(el("i")); typingEl.appendChild(el("i"));
    typingEl.appendChild(document.createTextNode(" " + (S.cfg.name || "The team") + " is typing"));
  }
  function render(stick, teamNew) {
    if (!list) return;
    badge.style.display = S.unread ? "block" : "none";
    badge.textContent = S.unread > 9 ? "9+" : String(S.unread);
    bubble.setAttribute("aria-label", (S.unread ? S.unread + " new message" + (S.unread > 1 ? "s" : "") + ". " : "") + "Open chat: " + S.cfg.settings.title);
    var keep = atBottom();
    var top = list.scrollTop;
    list.textContent = "";
    var c = S.cfg.settings;
    var lastDay = null;
    function day(at) { var d = new Date(at); var l = dayLabel(d); if (l !== lastDay) { lastDay = l; list.appendChild(el("div", "day", l)); } return d; }
    if (c.welcome) { var w = el("div", "row t"); w.appendChild(el("div", "m", c.welcome)); list.appendChild(w); }
    var prevFrom = null;
    S.msgs.forEach(function (m) {
      var d = day(m.at);
      var mine = m.from === "visitor";
      var row = el("div", "row " + (mine ? "v" : "t"));
      if (!mine && prevFrom !== m.from + (m.author || "")) {
        var a = el("div", "a");
        if (m.from === "ai") { a.appendChild(svg(ICONS.bot, 12)); a.appendChild(el("span", "ai", "AI assistant")); }
        else a.appendChild(document.createTextNode(m.author || S.cfg.name));
        row.appendChild(a);
      }
      prevFrom = mine ? null : m.from + (m.author || "");
      var b = el("div", "m");
      (m.attachments || []).forEach(function (at) {
        if (at.type === "IMAGE") { var img = el("img", "ph"); img.alt = at.name || "Photo"; img.loading = "lazy"; img.tabIndex = 0; img.onclick = function () { lightbox.textContent = ""; var big = el("img"); big.src = img.src; big.alt = img.alt; lightbox.appendChild(big); lightbox.className = "lb on"; }; showImage(m, at, img); b.appendChild(img); }
        else { var fb = el("button", "fl", "📎 " + (at.name || "file")); fb.type = "button"; fb.onclick = function () { openFile(m, at); }; b.appendChild(fb); }
      });
      if ((!m.attachments || !m.attachments.length) && m.files && m.files.length) m.files.forEach(function (f) { b.appendChild(el("span", "fl", "📎 " + f)); });
      if (m.text) b.appendChild(el("span", null, m.text));
      row.appendChild(b);
      row.appendChild(el("div", "tm", timeLabel(d) + (mine ? " · ✓" : "")));
      list.appendChild(row);
    });
    S.pending.forEach(function (p) {
      day(p.at);
      var row = el("div", "row v " + (p.failed ? "fail" : "pend"));
      row.appendChild(el("div", "m", p.text));
      if (p.failed) { var r = el("button", "rt", (p.error || "Not sent") + " · Retry"); r.type = "button"; r.onclick = function () { deliver(p); render(false); }; row.appendChild(r); }
      else row.appendChild(el("div", "tm", "Sending…"));
      list.appendChild(row);
    });
    drawTyping();
    // Stay where the visitor is reading; only follow new messages when they were already at the bottom.
    if (stick || keep) { list.scrollTop = list.scrollHeight; S.newBelow = false; }
    else { list.scrollTop = top; if (teamNew) S.newBelow = true; }
    newBtn.className = S.newBelow ? "nb on" : "nb";
  }

  // ── Starting, navigation, teardown ─────────────────────────────────────────────────────────────
  function onNavigate() { if (!S.destroyed) applyVisibility(); }
  function onVisibility() { if (S.destroyed) return; if (document.visibilityState === "visible") { poll(); schedule(); } else clearTimeout(S.timer); }
  function onKey(e) { if (e.key === "Escape" && S.open && root && e.composedPath && e.composedPath().indexOf(root) > -1) { S.userClosed = true; toggle(false); } }
  function patchHistory() {
    if (window.__getAssistHistoryPatched) return;
    window.__getAssistHistoryPatched = true;
    ["pushState", "replaceState"].forEach(function (name) {
      var orig = history[name];
      history[name] = function () { var r = orig.apply(this, arguments); window.dispatchEvent(new Event("getassist:navigate")); return r; };
    });
  }
  function start() {
    build();
    window.addEventListener("popstate", onNavigate);
    window.addEventListener("hashchange", onNavigate);
    window.addEventListener("getassist:navigate", onNavigate);
    if (mqMobile.addEventListener) mqMobile.addEventListener("change", onNavigate);
    if (S.cfg.settings.theme === "auto" && mqDark.addEventListener) mqDark.addEventListener("change", rebuild);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKey);
    patchHistory();
    if (S.token) poll();
    schedule();
    startTimers();
    applyVisibility();
  }
  function rebuild() { var wasOpen = S.open; if (root) root.remove(); picker = null; build(); if (wasOpen) toggle(true, { auto: true, silent: true }); applyVisibility(); }
  function destroy() {
    S.destroyed = true;
    clearTimeout(S.timer); timers.forEach(clearTimeout);
    window.removeEventListener("popstate", onNavigate); window.removeEventListener("hashchange", onNavigate); window.removeEventListener("getassist:navigate", onNavigate);
    document.removeEventListener("visibilitychange", onVisibility); document.removeEventListener("keydown", onKey);
    if (savedOverflow !== null) document.documentElement.style.overflow = savedOverflow;
    Object.keys(blobs).forEach(function (k) { URL.revokeObjectURL(blobs[k]); }); blobs = {};
    if (root) root.remove();
    root = panel = null;
    window.__getAssistChatLoaded = false;
  }
  opts.open = function () { if (panel) toggle(true); };
  opts.close = function () { if (panel) toggle(false, { silent: true }); };
  opts.destroy = destroy;

  if (preview) {
    // The settings page: a configuration and sample conversation, updated live by postMessage. No network at all.
    var pv = window.GetAssistChatPreview || {};
    function apply(data) {
      S.cfg = data.config; S.token = "preview"; S.msgs = (data.messages || []).slice(); S.pending = []; S.shown = true; S.agentTyping = Boolean(data.view && data.view.typing);
      if (root) root.remove(); picker = null; build();
      if (data.view && data.view.open) toggle(true, { auto: true, silent: true });
      if (data.view && data.view.teaser && !(data.view && data.view.open)) showTeaser(true);
    }
    if (pv.config) apply(pv);
    window.addEventListener("message", function (e) { if (e.source === window.parent && e.data && e.data.type === "getassist-preview" && e.data.config) apply(e.data); });
    return;
  }

  load();
  api("?v=" + VERSION, { method: "GET" }).then(function (cfg) { if (S.destroyed) return; S.cfg = cfg; start(); }).catch(function () { /* not allowed here, or switched off: render nothing */ });
})();`;
