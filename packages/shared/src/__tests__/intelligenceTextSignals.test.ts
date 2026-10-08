import { describe, expect, it } from "vitest";
import {
  detectCustomerConfirmation,
  detectCustomerSignals,
  detectEmployeeResolution,
  detectHandoff,
  detectStillBroken,
  INTELLIGENCE_SQL_PREFILTER,
  textNamesMember,
} from "../intelligence/textSignals.js";

/** Every catalogue is tested in both directions: real phrasing matches, ordinary chatter does not. */

const prefilter = new RegExp(INTELLIGENCE_SQL_PREFILTER, "i");

describe("internal hand-off", () => {
  it.each([
    ["I'll check with the developer", "HIGH"],
    ["Developer is checking", "HIGH"],
    ["I have forwarded this to the technical team", "HIGH"],
    ["Let me ask the technical team", "HIGH"],
    ["ডেভেলপারকে জানিয়েছি", "HIGH"],
    ["team ke janacchi vai", "HIGH"],
    ["Let me check and update you", "MEDIUM"],
    ["check kore janacchi", "MEDIUM"],
    ["চেক করে জানাচ্ছি", "MEDIUM"],
    ["Give me some time", "LOW"],
    ["ektu shomoy din vai", "LOW"],
    ["একটু অপেক্ষা করুন", "LOW"],
  ])("%s → %s", (text, level) => {
    expect(detectHandoff(text)).toBe(level);
    expect(prefilter.test(text)).toBe(true);
  });
  it.each(["Hello vai", "Your bill is 500 taka", "আসসালামু আলাইকুম", "developmental delay"])("not a hand-off: %s", (text) => {
    expect(detectHandoff(text)).toBeNull();
  });
});

describe("employee states a fix", () => {
  it.each(["Done vai", "It has been fixed", "Please check now", "hoye geche", "হয়ে গেছে", "সমাধান হয়েছে", "activate kore diyechi", "check korun"])("%s", (text) => {
    expect(detectEmployeeResolution(text)).toBe(true);
    expect(prefilter.test(text)).toBe(true);
  });
  it.each(["Hi, how can I help?", "What is your user id?", "undone task"])("not a fix: %s", (text) => {
    expect(detectEmployeeResolution(text)).toBe(false);
  });
});

describe("customer confirms, or it is still broken", () => {
  it.each(["Yes, it is working. Thank you", "working now vai", "thik hoyeche", "ঠিক হয়েছে", "কাজ করছে", "problem solved", "ok now"])("confirms: %s", (text) => {
    expect(detectCustomerConfirmation(text)).toBe(true);
    expect(prefilter.test(text)).toBe(true);
  });
  it.each(["still not working", "abar same problem", "কাজ করছে না", "hocche na vai", "ঠিক হয়নি", "same issue again"])("still broken: %s", (text) => {
    expect(detectStillBroken(text)).toBe(true);
    expect(detectCustomerConfirmation(text)).toBe(false);
    expect(prefilter.test(text)).toBe(true);
  });
  it.each(["internet is slow", "bill kivabe dibo?", "ok"])("neither: %s", (text) => {
    expect(detectCustomerConfirmation(text)).toBe(false);
    expect(detectStillBroken(text)).toBe(false);
  });
});

describe("thanks, praise, preference", () => {
  it("thanks alone is general thanks", () => {
    for (const text of ["Thank you ভাইয়া", "Thanks", "ধন্যবাদ", "tnx vai"]) {
      expect(detectCustomerSignals(text)).toMatchObject({ thanks: true, praise: false });
      expect(prefilter.test(text)).toBe(true);
    }
  });
  it("praise", () => {
    for (const text of ["আপনি অনেক ভালো support দেন", "ভাইয়া আপনি খুব ভালো support করেন", "great support, appreciate it", "you are the best"]) {
      expect(detectCustomerSignals(text).praise).toBe(true);
      expect(prefilter.test(text)).toBe(true);
    }
  });
  it("preference", () => {
    for (const text of ["আপনার কাছেই support নিতে চাই", "rahim vai ke din", "I want Karim bhai", "apnakei chai"]) {
      expect(detectCustomerSignals(text).preference).toBe(true);
      expect(prefilter.test(text)).toBe(true);
    }
    expect(detectCustomerSignals("I want to pay my bill").preference).toBe(false);
  });
  it("addressed to everyone", () => {
    expect(detectCustomerSignals("Thanks everyone").genericTeam).toBe(true);
    expect(detectCustomerSignals("সবাইকে ধন্যবাদ").genericTeam).toBe(true);
    expect(detectCustomerSignals("Thanks vai").genericTeam).toBe(false);
  });
});

describe("a member named in the text", () => {
  it("by first name, as a whole word, case-insensitive", () => {
    expect(textNamesMember("Thanks Rahim vai", "Rahim Uddin")).toBe(true);
    expect(textNamesMember("thanks RAHIM", "Rahim Uddin")).toBe(true);
    expect(textNamesMember("Ibrahim helped", "Rahim Uddin")).toBe(false);
  });
  it("never by a short or generic name", () => {
    expect(textNamesMember("al is here", "Al Amin")).toBe(false);
    expect(textNamesMember("support was great", "Support Desk")).toBe(false);
  });
});
