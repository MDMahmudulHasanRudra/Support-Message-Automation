/**
 * Phrase catalogues for Support Intelligence (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md §E.10):
 * what an employee's words say about a hand-off or a fix, and what a customer's words say about a
 * fix, a recurring problem, thanks, praise or a preference.
 *
 * Every detection here is an INFERENCE from text, never a fact, and each carries a confidence. The
 * catalogues cover English, Bangla and Banglish (Bangla in Latin letters), the three ways this
 * deployment's customers and staff write. They will miss some messages and misread some jokes —
 * which is why Low confidence never counts toward a figure, and why every figure opens its message.
 *
 * Word boundaries are Unicode-aware: JavaScript's `\b` does not treat Bengali letters as word
 * characters, so a plain `\b` would match inside Bengali words or not at all.
 */

export type SignalConfidence = "HIGH" | "MEDIUM" | "LOW";

const L = "[\\p{L}\\p{M}\\p{N}]";
/** A whole-phrase matcher: none of the alternatives may sit inside a longer word. */
function phrases(...alternatives: string[]): RegExp {
  return new RegExp(`(?<!${L})(?:${alternatives.join("|")})(?!${L})`, "iu");
}

/** Normalises what the detectors read: lower case, collapsed spaces, no zero-width joiners. */
export function normalizeSignalText(text: string): string {
  return text.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Employee: internal hand-off

/** Names another party who will act — the developer, the technical team, "forwarded". */
const HANDOFF_HIGH = phrases(
  "developers?",
  "dev team",
  "technical team",
  "tech team",
  "technical (?:department|person|side)",
  "engineers?",
  "backend team",
  "it team",
  "server team",
  "network team",
  "forwarded",
  "forward kor\\S*",
  "forward (?:it|this|kore)",
  "escalat\\S*",
  "ডেভেলপার\\S*",
  "টেকনিক্যাল টিম\\S*",
  "টেক টিম\\S*",
  "ইঞ্জিনিয়ার\\S*",
  "ফরোয়ার্ড\\S*",
  "developer ke",
  "team ke (?:janacchi|janiyechi|janano hoyeche|bolchi|bolechi)",
);
/** Says the employee will investigate and come back — internal work, someone may be consulted. */
const HANDOFF_MEDIUM = phrases(
  "let me check",
  "i will check",
  "i'll check",
  "will check and (?:let you know|update|inform)",
  "check(?:ing)? with (?:the )?(?:team|office|management)",
  "check kore (?:janacchi|janabo|jananu|dekhchi|dekhi)",
  "dekhe janacchi",
  "dekhe janabo",
  "চেক করে জানাচ্ছি",
  "চেক করে জানাব",
  "দেখে জানাচ্ছি",
  "দেখে জানাব",
  "জানাচ্ছি",
  "i will update you",
  "will update you",
  "update (?:janabo|dicchi|dibo)",
);
/** Only asks for patience — the weakest sign anything is being handed on. */
const HANDOFF_LOW = phrases(
  "give me (?:some |a little |a )?(?:time|moment|minute|minutes)",
  "please wait",
  "wait (?:a bit|a moment|koren|korun)",
  "ektu (?:shomoy|somoy|wait)",
  "একটু সময় দিন",
  "একটু অপেক্ষা করুন",
  "অপেক্ষা করুন",
  "kichu khon (?:wait|opekkha)",
);

export function detectHandoff(text: string): SignalConfidence | null {
  const t = normalizeSignalText(text);
  if (HANDOFF_HIGH.test(t)) return "HIGH";
  if (HANDOFF_MEDIUM.test(t)) return "MEDIUM";
  if (HANDOFF_LOW.test(t)) return "LOW";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Employee: states a fix

const EMPLOYEE_RESOLVED = phrases(
  "done",
  "fixed",
  "solved",
  "resolved",
  "has been (?:fixed|solved|resolved|done|activated|updated)",
  "is (?:fixed|solved|resolved|working)(?: now)?",
  "(?:it'?s|its) (?:working|fixed|solved|ok) now",
  "working now",
  "please check (?:now|again|once)",
  "check (?:now|again) please",
  "check korun",
  "ekhon check",
  "hoye (?:geche|gese|gece)",
  "thik kore (?:diyechi|disi|dichi|deya hoyeche)",
  "solve (?:kora hoyeche|korechi|kore diyechi|hoye geche)",
  "(?:activate|active|chalu|update|on) kore (?:diyechi|disi|deya hoyeche)",
  "হয়ে গেছে",
  "ঠিক করা হয়েছে",
  "ঠিক করে দিয়েছি",
  "সমাধান (?:করা )?হয়েছে",
  "চেক করুন",
  "এখন চেক",
  "চালু করে দিয়েছি",
);

export function detectEmployeeResolution(text: string): boolean {
  return EMPLOYEE_RESOLVED.test(normalizeSignalText(text));
}

// ---------------------------------------------------------------------------------------------
// Customer: confirms, or says it is still broken

/** The customer saying the problem is gone. Checked AFTER still-broken: "still not working" contains "working". */
const CUSTOMER_CONFIRM = phrases(
  "(?:it'?s|its|it is|is) working(?: now)?",
  "working now",
  "works now",
  "now (?:it )?works",
  "(?:problem |issue )?(?:solved|resolved|fixed)",
  "ok now",
  "okay now",
  "all (?:good|ok|okay) now",
  "thik (?:hoyeche|hoise|hoyse|hoye geche)",
  "ekhon thik (?:ache|ase)",
  "kaj (?:korche|kortese|korteche)",
  "cholche",
  "choltese",
  "paichi",
  "peyechi",
  "পেয়েছি",
  "ঠিক হয়েছে",
  "ঠিক হয়ে গেছে",
  "এখন ঠিক আছে",
  "কাজ করছে",
  "চলছে",
  "সমাধান হয়েছে",
);
const STILL_BROKEN = phrases(
  "still (?:not|no|isn'?t|doesn'?t|don'?t|the same|same|down|having)",
  "not working",
  "doesn'?t work",
  "isn'?t working",
  "same (?:problem|issue|thing)",
  "again (?:the )?(?:same|problem|issue|not working|down)",
  "abar",
  "ekhono",
  "ekhon[oo]? (?:hocche|kaj kor) na",
  "hocche na",
  "hoche na",
  "kaj korche na",
  "kaj kortese na",
  "cholche na",
  "thik hoy ?ni",
  "আবার",
  "এখনও",
  "এখনো",
  "হচ্ছে না",
  "কাজ করছে না",
  "চলছে না",
  "ঠিক হয়নি",
);

export function detectStillBroken(text: string): boolean {
  return STILL_BROKEN.test(normalizeSignalText(text));
}

export function detectCustomerConfirmation(text: string): boolean {
  const t = normalizeSignalText(text);
  if (STILL_BROKEN.test(t)) return false;
  return CUSTOMER_CONFIRM.test(t);
}

// ---------------------------------------------------------------------------------------------
// Customer: thanks, praise, preference

const THANKS = phrases("thanks?", "thank you", "thank u", "thanku", "thankyou", "thx", "thnx", "tnx", "tnq", "ty", "ধন্যবাদ", "dhonnobad", "dhonyobad", "dhonnobaad", "shukriya", "জাজাকাল্লাহ", "jazakallah\\S*");
const PRAISE = phrases(
  "(?:very|so|really|too) (?:good|helpful|nice|kind)",
  "great (?:support|help|job|service|work)",
  "good (?:support|service|job|work)",
  "best (?:support|service|person)",
  "excellent",
  "helpful",
  "appreciate\\S*",
  "you(?:'re| are) (?:the )?(?:best|great|amazing)",
  "(?:always|sobsomoy|sob somoy) (?:help|helps|support)",
  "valo support",
  "bhalo support",
  "onek valo",
  "onek bhalo",
  "khub valo",
  "apni onek",
  "ভালো সাপোর্ট",
  "ভালো support",
  "অনেক ভালো",
  "খুব ভালো",
  "সবসময় (?:help|সাহায্য)",
  "আপনি অনেক",
);
const PREFERENCE = phrases(
  "(?:want|need|prefer|only) (?:to talk to |to speak to |help from )?\\S+ (?:bhai|vai|bhaiya|vaiya|apu|sir)",
  "apnar kachei",
  "apnar kache(?:i)? (?:support|help) nite chai",
  "apnakei",
  "apnake(?:i)? chai",
  "আপনার কাছেই",
  "আপনাকেই",
  "আপনার কাছে (?:support|সাপোর্ট) নিতে চাই",
  "\\S+ (?:bhai|vai|bhaiya|vaiya|apu)(?: ke| k)? (?:din|dao|chai|dorkar|lagbe)",
  "\\S+ (?:ভাই|ভাইয়া|আপু)(?:কে| কে)? (?:দিন|চাই|দরকার|লাগবে)",
);
/** Addressed to everyone — never attributed to one employee, however warm. */
const GENERIC_TEAM = phrases("everyone", "everybody", "all of you", "you all", "your team", "the team", "team", "সবাই\\S*", "sobai\\S*", "sobaike", "আপনাদের", "apnader", "apnara", "আপনারা");

export type AppreciationKind = "GENERAL_THANKS" | "EMPLOYEE_PRAISE";

export interface CustomerTextSignals {
  thanks: boolean;
  praise: boolean;
  preference: boolean;
  genericTeam: boolean;
}

export function detectCustomerSignals(text: string): CustomerTextSignals {
  const t = normalizeSignalText(text);
  return { thanks: THANKS.test(t), praise: PRAISE.test(t), preference: PREFERENCE.test(t), genericTeam: GENERIC_TEAM.test(t) };
}

/**
 * Whether a member's name appears as a word in the text. First name, at least three letters, so
 * "Ali" matches and "Al" does not; a name that is also a common word (listed) never matches alone.
 */
const NAME_STOPWORDS = new Set(["support", "team", "admin", "bhai", "vai", "apu", "sir", "help", "office"]);
export function textNamesMember(text: string, memberName: string): boolean {
  const first = normalizeSignalText(memberName).split(" ")[0] ?? "";
  if (first.length < 3 || NAME_STOPWORDS.has(first)) return false;
  return new RegExp(`(?<!${L})${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!${L})`, "iu").test(normalizeSignalText(text));
}

// ---------------------------------------------------------------------------------------------

/**
 * A database pre-filter, so only messages that could match a catalogue send their text to the
 * report. A superset by construction: it lists the stems every detector above starts from (the
 * unit test checks every catalogue example passes it). Postgres `~*` syntax: no lookbehind.
 */
export const INTELLIGENCE_SQL_PREFILTER = [
  "develop", "dev team", "technical", "tech team", "engineer", "backend", "it team", "server team", "network team",
  "forward", "escalat", "ডেভেলপ", "টেকনিক", "টেক টিম", "ইঞ্জিনিয়ার", "ফরোয়ার্ড", "team ke",
  "check", "চেক", "dekhe jan", "দেখে জান", "জানাচ্ছি", "জানাব", "update",
  "time", "moment", "minute", "wait", "shomoy", "somoy", "সময়", "অপেক্ষা", "opekkha",
  "done", "fix", "solv", "resolv", "working", "works", "hoye ge", "thik kor", "kore diyechi", "kore disi", "deya hoyeche",
  "হয়ে গেছে", "ঠিক কর", "সমাধান", "চালু",
  "ok now", "okay now", "good now", "thik ho", "thik ach", "thik as", "kaj kor", "cholc", "choltes", "paichi", "peyechi", "পেয়েছি",
  "ঠিক হ", "ঠিক আছে", "কাজ কর", "চলছ",
  "still", "not work", "doesn", "isn", "same", "again", "abar", "ekhon", "hocche na", "hoche na", "আবার", "এখন", "হচ্ছে না", "ঠিক হয়নি",
  "thank", "thx", "thnx", "tnx", "tnq", "ty", "ধন্যবাদ", "dhonno", "dhonyo", "shukriya", "জাজাকাল্লাহ", "jazakallah",
  "good", "great", "best", "nice", "kind", "excellent", "helpful", "help", "appreciat", "amazing",
  "valo", "bhalo", "onek", "khub", "apni", "ভালো", "অনেক", "খুব", "সবসময়", "আপনি", "sobsomoy", "sob somoy", "always",
  "want", "need", "prefer", "only", "kachei", "kache", "apnake", "chai", "dorkar", "lagbe", " din", " dao",
  "কাছে", "আপনাকে", "চাই", "দরকার", "লাগবে", "দিন",
].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
