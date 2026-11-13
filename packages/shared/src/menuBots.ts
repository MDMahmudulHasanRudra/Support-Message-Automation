import { toAsciiDigits } from "./contacts.js";

/**
 * Menu bots (MENU_BOTS.md, feature MENU_BOTS): a numbered menu a customer answers by typing a number. Numbers rather than
 * buttons because a linked-device WhatsApp number cannot send buttons. Everything here is pure, so the editor's test
 * panel and the worker answer exactly the same way.
 */

export const MENU_NODE_KINDS = ["MENU", "ANSWER", "HANDOFF"] as const;
export type MenuNodeKind = (typeof MENU_NODE_KINDS)[number];

export const MENU_NODE_KIND_LABEL: Record<MenuNodeKind, string> = {
  MENU: "Menu of choices",
  ANSWER: "Answer",
  HANDOFF: "Hand to a person",
};

export interface MenuOption {
  label: string;
  goTo: string;
}

export interface MenuNode {
  id: string;
  title: string;
  text: string;
  kind: MenuNodeKind;
  options: MenuOption[];
}

export interface MenuTree {
  rootId: string;
  nodes: Record<string, MenuNode>;
}

export const MAX_MENU_NODES = 200;
export const MAX_MENU_OPTIONS = 9;
export const MAX_MENU_TEXT = 1000;
export const MAX_MENU_LABEL = 60;
export const MAX_MENU_TITLE = 60;

/** The channels a bot can answer on besides WhatsApp. */
export const MENU_BOT_CHANNELS = ["WHATSAPP_CLOUD", "MESSENGER", "INSTAGRAM", "TELEGRAM", "WEBCHAT"] as const;
export type MenuBotChannel = (typeof MENU_BOT_CHANNELS)[number];
export const MENU_BOT_CHANNEL_LABEL: Record<MenuBotChannel, string> = { WHATSAPP_CLOUD: "WhatsApp (Official)", MESSENGER: "Messenger", INSTAGRAM: "Instagram", TELEGRAM: "Telegram", WEBCHAT: "Website chat" };

/** Marks a menu reply in the outbound queue. A menu step is not an AI answer, so the AI reply cooldown ignores it. */
export const MENU_BOT_VARIANT = "menu-bot";

export interface MenuBotWording {
  invalidText: string;
  handoffText: string;
  backLabel: string;
  homeLabel: string;
  maxInvalid: number;
}

export const DEFAULT_MENU_WORDING: MenuBotWording = {
  invalidText: "Sorry, please reply with one of the numbers below.",
  handoffText: "Thank you. A member of our team will reply to you here shortly.",
  backLabel: "Back",
  homeLabel: "Main menu",
  maxInvalid: 2,
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A tree from the editor or the database. Null when it cannot be read as one at all. */
export function readMenuTree(raw: unknown): MenuTree | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { rootId?: unknown; nodes?: unknown };
  if (typeof r.rootId !== "string" || !r.nodes || typeof r.nodes !== "object") return null;
  const nodes: Record<string, MenuNode> = {};
  for (const [id, value] of Object.entries(r.nodes as Record<string, unknown>).slice(0, MAX_MENU_NODES)) {
    if (!value || typeof value !== "object" || !/^[\w-]{1,40}$/.test(id)) return null;
    const n = value as Record<string, unknown>;
    const kind = MENU_NODE_KINDS.find((k) => k === n.kind);
    if (!kind) return null;
    const options = Array.isArray(n.options) ? (n.options as Array<Record<string, unknown>>) : [];
    nodes[id] = {
      id,
      title: str(n.title, MAX_MENU_TITLE),
      text: typeof n.text === "string" ? n.text.trim().slice(0, MAX_MENU_TEXT) : "",
      kind,
      options: kind === "MENU" ? options.slice(0, MAX_MENU_OPTIONS).map((o) => ({ label: str(o.label, MAX_MENU_LABEL), goTo: str(o.goTo, 40) })) : [],
    };
  }
  return nodes[r.rootId] ? { rootId: r.rootId, nodes } : null;
}

/** What stops this bot going live, in plain words. Empty means it can be switched on. */
export function menuTreeProblems(tree: MenuTree): string[] {
  const problems: string[] = [];
  const name = (n: MenuNode) => `"${n.title || "Untitled step"}"`;
  if (tree.nodes[tree.rootId]?.kind !== "MENU") problems.push("The first step must be a menu of choices.");
  for (const node of Object.values(tree.nodes)) {
    if (!node.text) problems.push(`${name(node)} has no message.`);
    if (/\[your /i.test(node.text)) problems.push(`${name(node)} still has a placeholder to fill in.`);
    if (node.kind === "MENU") {
      if (node.options.length === 0) problems.push(`${name(node)} has no choices.`);
      for (const option of node.options) {
        if (!option.label) problems.push(`${name(node)} has a choice with no name.`);
        if (!tree.nodes[option.goTo]) problems.push(`${name(node)}: the choice "${option.label}" leads nowhere.`);
      }
    }
  }
  return [...new Set(problems)];
}

export function menuKeywordKey(text: string): string {
  return toAsciiDigits(text).trim().toLowerCase().replace(/[\s.,!?।:;)(-]+$/u, "").replace(/\s+/g, " ");
}

export function readMenuKeywords(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\n]/) : [];
  return [...new Set(parts.map((p) => menuKeywordKey(String(p))).filter(Boolean))].slice(0, 30);
}

/** The whole message must be the word: a keyword inside a sentence is somebody saying something else. */
export function menuTriggerMatches(keywords: readonly string[], text: string): boolean {
  return keywords.includes(menuKeywordKey(text));
}

const HUMAN_WORDS = new Set(["agent", "human", "person", "operator", "representative", "talk to agent", "talk to a person", "এজেন্ট", "প্রতিনিধি", "মানুষ"]);

export interface MenuSessionState {
  nodeId: string;
  path: string[];
  invalidCount: number;
}

export type MenuEventKind = "STARTED" | "CHOSE" | "BACK" | "RESTART" | "INVALID" | "HANDOFF" | "RELEASED";

export type MenuStep =
  | { action: "RELEASE"; event: "RELEASED" }
  | { action: "REPLY"; reply: string; state: MenuSessionState; status: "ACTIVE" | "HANDED_OFF"; event: MenuEventKind; nodeId: string; optionLabel: string | null };

/** How a step reads on the customer's phone. */
export function renderMenuNode(node: MenuNode, path: readonly string[], wording: Pick<MenuBotWording, "backLabel" | "homeLabel">): string {
  if (node.kind === "HANDOFF") return node.text;
  const lines: string[] = [node.text];
  if (node.kind === "MENU") {
    lines.push("", ...node.options.map((o, i) => `${i + 1}. ${o.label}`));
    if (path.length > 0) lines.push("", `0. ${wording.backLabel}`);
    return lines.join("\n");
  }
  lines.push("", `0. ${wording.backLabel}`, `00. ${wording.homeLabel}`);
  return lines.join("\n");
}

function enter(tree: MenuTree, nodeId: string, path: string[], wording: MenuBotWording, event: MenuEventKind, optionLabel: string | null): MenuStep {
  const node = tree.nodes[nodeId]!;
  return { action: "REPLY", reply: renderMenuNode(node, path, wording), state: { nodeId, path, invalidCount: 0 }, status: node.kind === "HANDOFF" ? "HANDED_OFF" : "ACTIVE", event: node.kind === "HANDOFF" ? "HANDOFF" : event, nodeId, optionLabel };
}

function handOff(state: MenuSessionState, wording: MenuBotWording): MenuStep {
  return { action: "REPLY", reply: wording.handoffText, state, status: "HANDED_OFF", event: "HANDOFF", nodeId: state.nodeId, optionLabel: null };
}

/** The first message of a session. */
export function startMenu(tree: MenuTree, wording: MenuBotWording): MenuStep {
  return enter(tree, tree.rootId, [], wording, "STARTED", null);
}

/**
 * One customer message against one session. RELEASE means this message is not an answer to the menu: the session ends and
 * the message goes on to the rules and AI as if the bot were not there.
 */
export function advanceMenu(tree: MenuTree, state: MenuSessionState, text: string, wording: MenuBotWording, restartKeywords: readonly string[] = []): MenuStep {
  const node = tree.nodes[state.nodeId];
  if (!node) return { action: "RELEASE", event: "RELEASED" };
  const key = menuKeywordKey(text);
  if (!key) return { action: "RELEASE", event: "RELEASED" };

  if (HUMAN_WORDS.has(key)) return handOff(state, wording);
  if (key === "00" || restartKeywords.includes(key)) return enter(tree, tree.rootId, [], wording, "RESTART", null);
  if (key === "0") {
    if (state.path.length === 0) return enter(tree, tree.rootId, [], wording, "RESTART", null);
    const path = state.path.slice(0, -1);
    return enter(tree, state.path[state.path.length - 1]!, path, wording, "BACK", null);
  }

  if (node.kind === "MENU") {
    const number = /^\d{1,2}$/.test(key) ? Number(key) : null;
    const chosen = number !== null ? node.options[number - 1] : node.options.find((o) => menuKeywordKey(o.label) === key);
    if (chosen && tree.nodes[chosen.goTo]) return enter(tree, chosen.goTo, [...state.path, node.id], wording, "CHOSE", chosen.label);
  }

  // A sentence is somebody saying something, not a mistyped number.
  if (key.split(" ").length > 3) return { action: "RELEASE", event: "RELEASED" };
  if (node.kind === "ANSWER" && number0to9(key) === null) return { action: "RELEASE", event: "RELEASED" };

  const invalidCount = state.invalidCount + 1;
  if (invalidCount >= wording.maxInvalid) return handOff({ ...state, invalidCount }, wording);
  return { action: "REPLY", reply: `${wording.invalidText}\n\n${renderMenuNode(node, state.path, wording)}`, state: { ...state, invalidCount }, status: "ACTIVE", event: "INVALID", nodeId: node.id, optionLabel: null };
}

function number0to9(key: string): number | null {
  return /^\d{1,2}$/.test(key) ? Number(key) : null;
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────────

type Item = { label: string; text: string; handoff?: boolean; options?: Item[] };

function buildTree(rootText: string, items: Item[]): MenuTree {
  let counter = 0;
  const nodes: Record<string, MenuNode> = {};
  const add = (title: string, text: string, children?: Item[], handoff?: boolean): string => {
    counter += 1;
    const id = `n${counter}`;
    const node: MenuNode = { id, title, text, kind: children ? "MENU" : handoff ? "HANDOFF" : "ANSWER", options: [] };
    nodes[id] = node;
    if (children) node.options = children.map((c) => ({ label: c.label, goTo: add(c.label, c.text, c.options, c.handoff) }));
    return id;
  };
  const rootId = add("Main menu", rootText, items);
  return { rootId, nodes };
}

export interface MenuBotTemplate {
  id: string;
  name: string;
  description: string;
  language: "English" | "বাংলা";
  keywords: string[];
  wording: MenuBotWording;
  tree: MenuTree;
}

const BN_WORDING: MenuBotWording = {
  invalidText: "দুঃখিত, নিচের নম্বরগুলোর একটি লিখে পাঠান।",
  handoffText: "ধন্যবাদ। আমাদের টিমের একজন শীঘ্রই এখানে আপনাকে উত্তর দেবেন।",
  backLabel: "পেছনে",
  homeLabel: "মূল মেনু",
  maxInvalid: 2,
};

const EN_KEYS = ["menu", "hi", "hello", "start"];
const BN_KEYS = ["menu", "hi", "hello", "মেনু", "হাই", "হ্যালো", "সালাম", "আসসালামু আলাইকুম"];

export const MENU_BOT_TEMPLATES: readonly MenuBotTemplate[] = [
  {
    id: "support-en",
    name: "Customer support",
    description: "Opening hours, prices, payment and a way to reach a person.",
    language: "English",
    keywords: EN_KEYS,
    wording: DEFAULT_MENU_WORDING,
    tree: buildTree("Welcome! How can we help you today? Please reply with a number.", [
      { label: "Opening hours", text: "We are open [your days and hours]." },
      { label: "Prices", text: "Our prices: [your price list]." },
      { label: "How to pay", text: "You can pay by [your payment methods and numbers]." },
      { label: "Where to find us", text: "We are at [your address]." },
      { label: "Talk to a person", text: "Thank you. A member of our team will reply to you here shortly.", handoff: true },
    ]),
  },
  {
    id: "support-bn",
    name: "কাস্টমার সাপোর্ট",
    description: "খোলার সময়, দাম, পেমেন্ট এবং একজন মানুষের সাথে কথা বলার সুযোগ।",
    language: "বাংলা",
    keywords: BN_KEYS,
    wording: BN_WORDING,
    tree: buildTree("স্বাগতম! কীভাবে সাহায্য করতে পারি? একটি নম্বর লিখে পাঠান।", [
      { label: "খোলার সময়", text: "আমরা খোলা থাকি [your days and hours]।" },
      { label: "দাম", text: "আমাদের দাম: [your price list]।" },
      { label: "পেমেন্টের নিয়ম", text: "আপনি পেমেন্ট করতে পারেন [your payment methods and numbers]।" },
      { label: "ঠিকানা", text: "আমাদের ঠিকানা: [your address]।" },
      { label: "একজন প্রতিনিধির সাথে কথা বলুন", text: "ধন্যবাদ। আমাদের টিমের একজন শীঘ্রই এখানে আপনাকে উত্তর দেবেন।", handoff: true },
    ]),
  },
  {
    id: "shop-en",
    name: "Online shop",
    description: "Delivery, returns, order status and sales.",
    language: "English",
    keywords: EN_KEYS,
    wording: DEFAULT_MENU_WORDING,
    tree: buildTree("Thanks for messaging us! What would you like to do?", [
      { label: "Order something", text: "Tell us the product you want and a member of our team will confirm it with you.", handoff: true },
      { label: "Where is my order?", text: "Please send your order number and a member of our team will check it for you.", handoff: true },
      {
        label: "Delivery",
        text: "Delivery details. Choose one:",
        options: [
          { label: "Delivery charge", text: "Delivery costs [your delivery charges]." },
          { label: "Delivery time", text: "Delivery takes [your delivery time]." },
        ],
      },
      { label: "Return or exchange", text: "You can return or exchange within [your return policy]." },
      { label: "How to pay", text: "We accept [your payment methods and numbers]." },
    ]),
  },
  {
    id: "shop-bn",
    name: "অনলাইন শপ",
    description: "ডেলিভারি, রিটার্ন, অর্ডারের অবস্থা এবং বিক্রি।",
    language: "বাংলা",
    keywords: BN_KEYS,
    wording: BN_WORDING,
    tree: buildTree("মেসেজ করার জন্য ধন্যবাদ! আপনি কী করতে চান?", [
      { label: "অর্ডার করতে চাই", text: "কোন পণ্যটি চান লিখে পাঠান, আমাদের টিমের একজন নিশ্চিত করবেন।", handoff: true },
      { label: "আমার অর্ডার কোথায়?", text: "আপনার অর্ডার নম্বর পাঠান, আমাদের টিমের একজন দেখে জানাবেন।", handoff: true },
      {
        label: "ডেলিভারি",
        text: "ডেলিভারির তথ্য। একটি বেছে নিন:",
        options: [
          { label: "ডেলিভারি চার্জ", text: "ডেলিভারি চার্জ [your delivery charges]।" },
          { label: "ডেলিভারির সময়", text: "ডেলিভারি হতে সময় লাগে [your delivery time]।" },
        ],
      },
      { label: "রিটার্ন বা এক্সচেঞ্জ", text: "রিটার্ন বা এক্সচেঞ্জ করা যাবে [your return policy]।" },
      { label: "পেমেন্টের নিয়ম", text: "আমরা নিই [your payment methods and numbers]।" },
    ]),
  },
  {
    id: "isp-bn",
    name: "ইন্টারনেট সেবা",
    description: "লাইনের সমস্যা, বিল, প্যাকেজ এবং নতুন সংযোগ।",
    language: "বাংলা",
    keywords: BN_KEYS,
    wording: BN_WORDING,
    tree: buildTree("স্বাগতম! আপনার কী প্রয়োজন? একটি নম্বর লিখে পাঠান।", [
      { label: "ইন্টারনেট চলছে না", text: "আপনার রাউটার একবার বন্ধ করে ১ মিনিট পর চালু করুন। তারপরও না চললে আপনার ইউজার আইডি পাঠান, আমাদের টিমের একজন দেখবেন।", handoff: true },
      { label: "বিল ও পেমেন্ট", text: "বিল দিতে পারেন [your payment methods and numbers]।" },
      { label: "প্যাকেজ ও দাম", text: "আমাদের প্যাকেজ: [your packages and prices]।" },
      { label: "নতুন সংযোগ", text: "আপনার নাম, ঠিকানা ও ফোন নম্বর পাঠান, আমাদের টিমের একজন যোগাযোগ করবেন।", handoff: true },
      { label: "একজন প্রতিনিধির সাথে কথা বলুন", text: "ধন্যবাদ। আমাদের টিমের একজন শীঘ্রই এখানে আপনাকে উত্তর দেবেন।", handoff: true },
    ]),
  },
];

export function blankMenuTree(): MenuTree {
  return { rootId: "n1", nodes: { n1: { id: "n1", title: "Main menu", text: "Welcome! Please reply with a number.", kind: "MENU", options: [] } } };
}

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  matchType: "KEYWORDS" | "ALWAYS";
  replyMessage: string;
  cooldownSeconds: number;
  priority: number;
  timeWindow?: { startHour: number; endHour: number };
}

/** Ready-made auto-reply rules. Each is added as a DRAFT to edit and switch on: nothing here answers anyone by itself. */
export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  { id: "greeting", name: "Greeting", description: "Answers a plain hello, once in a while.", keywords: ["hi", "hello", "হাই", "হ্যালো", "সালাম", "আসসালামু আলাইকুম"], matchType: "KEYWORDS", replyMessage: "আসসালামু আলাইকুম। কীভাবে সাহায্য করতে পারি?", cooldownSeconds: 43_200, priority: 60 },
  { id: "thanks", name: "Thank you", description: "A warm reply when someone says thanks.", keywords: ["thanks", "thank you", "ধন্যবাদ"], matchType: "KEYWORDS", replyMessage: "আপনাকেও ধন্যবাদ। আর কিছু প্রয়োজন হলে জানাবেন।", cooldownSeconds: 3_600, priority: 40 },
  { id: "hours", name: "Opening hours", description: "When someone asks when you are open.", keywords: ["opening hours", "office time", "open time", "কখন খোলা", "অফিস টাইম"], matchType: "KEYWORDS", replyMessage: "আমরা খোলা থাকি [your days and hours]।", cooldownSeconds: 3_600, priority: 50 },
  { id: "price", name: "Prices", description: "When someone asks what it costs.", keywords: ["price", "how much", "দাম", "কত টাকা"], matchType: "KEYWORDS", replyMessage: "আমাদের দাম: [your price list]।", cooldownSeconds: 3_600, priority: 50 },
  { id: "payment", name: "How to pay", description: "bKash, Nagad, bank: how to pay you.", keywords: ["payment", "bkash", "nagad", "পেমেন্ট", "বিকাশ", "নগদ"], matchType: "KEYWORDS", replyMessage: "পেমেন্ট করতে পারেন [your payment methods and numbers]।", cooldownSeconds: 3_600, priority: 50 },
  { id: "address", name: "Address", description: "When someone asks where you are.", keywords: ["address", "location", "ঠিকানা", "লোকেশন"], matchType: "KEYWORDS", replyMessage: "আমাদের ঠিকানা: [your address]।", cooldownSeconds: 3_600, priority: 50 },
  { id: "delivery", name: "Delivery time", description: "When someone asks how long delivery takes.", keywords: ["delivery", "delivery time", "ডেলিভারি", "কবে পাব", "কত দিনে"], matchType: "KEYWORDS", replyMessage: "ঢাকার ভেতরে [x] দিনে এবং ঢাকার বাইরে [y] দিনে ডেলিভারি হয়।", cooldownSeconds: 3_600, priority: 50 },
  { id: "order-status", name: "Order status", description: "Asks for the order number so the team can check.", keywords: ["order status", "my order", "অর্ডার কোথায়", "আমার অর্ডার", "অর্ডার স্ট্যাটাস"], matchType: "KEYWORDS", replyMessage: "আপনার অর্ডার নম্বরটি পাঠান, আমাদের টিমের একজন দেখে জানাবেন।", cooldownSeconds: 1_800, priority: 55 },
  { id: "returns", name: "Returns and refunds", description: "Your return and refund rules.", keywords: ["return", "refund", "ফেরত", "রিফান্ড", "রিটার্ন"], matchType: "KEYWORDS", replyMessage: "পণ্য ফেরত বা টাকা ফেরতের নিয়ম: [your return policy]। বিস্তারিত জানতে অর্ডার নম্বর পাঠান।", cooldownSeconds: 3_600, priority: 50 },
  { id: "internet-down", name: "Internet not working", description: "First step for a broken connection (internet providers).", keywords: ["internet not working", "no internet", "net nai", "নেট নেই", "লাইন নেই", "ইন্টারনেট চলছে না"], matchType: "KEYWORDS", replyMessage: "আপনার রাউটারটি একবার বন্ধ করে ১ মিনিট পর চালু করুন। তারপরও না চললে আপনার ইউজার আইডি পাঠান, আমাদের টিমের একজন দেখবেন।", cooldownSeconds: 1_800, priority: 55 },
  { id: "hotline", name: "Phone number", description: "When someone asks for a number to call.", keywords: ["phone number", "hotline", "call", "নম্বর", "হটলাইন", "ফোন নম্বর"], matchType: "KEYWORDS", replyMessage: "আমাদের হটলাইন নম্বর: [your number]। [your call hours] কল করতে পারেন।", cooldownSeconds: 3_600, priority: 45 },
  { id: "talk-to-person", name: "Talk to a person", description: "Lets the customer know a person will reply.", keywords: ["agent", "human", "representative", "প্রতিনিধি", "মানুষের সাথে কথা"], matchType: "KEYWORDS", replyMessage: "ঠিক আছে। আমাদের টিমের একজন শীঘ্রই এখানে আপনাকে উত্তর দেবেন।", cooldownSeconds: 1_800, priority: 65 },
  { id: "after-hours", name: "Outside office hours", description: "Tells people when you will reply, at night only.", keywords: [], matchType: "ALWAYS", replyMessage: "আমাদের অফিস এখন বন্ধ। আমরা সকালে আপনার মেসেজের উত্তর দেব।", cooldownSeconds: 21_600, priority: 10, timeWindow: { startHour: 22, endHour: 8 } },
];
