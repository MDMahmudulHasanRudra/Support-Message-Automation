import { describe, expect, it } from "vitest";
import { collapseWaiting, deviceLabel, isAllowedPushEndpoint, pushBody, wantsAlert, type PushAlert } from "@/lib/pushRules";

const alert = (over: Partial<PushAlert> = {}): PushAlert => ({
  kind: "WAITING",
  projectId: "p",
  conversationKey: "c1",
  title: "Rahim",
  preview: "Internet line down",
  url: "/p/x/chat/account/a/g",
  inboxUrl: "/p/x/conversations/all",
  ...over,
});

describe("the address the server will POST to", () => {
  it("accepts the browsers' own push services", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    }
  });

  it("refuses anywhere else a signed-in person might aim the server", () => {
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://postgres:5432/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilpush.apple.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pass@fcm.googleapis.com/x",
      "not a url",
      "",
      null,
      42,
    ]) {
      expect(isAllowedPushEndpoint(bad), String(bad)).toBe(false);
    }
  });
});

describe("what a notification shows", () => {
  it("keeps a customer's words off the lock screen unless the device asked for them", () => {
    expect(pushBody(alert(), false)).toBe("A customer is waiting");
    expect(pushBody(alert(), true)).toBe("Internet line down");
    expect(pushBody(alert({ preview: null }), true)).toBe("A customer is waiting");
    expect(pushBody(alert({ preview: "x".repeat(300) }), true).length).toBe(118);
  });

  it("follows each device's choices", () => {
    const prefs = { notifyAssigned: true, notifyCustomerMessages: false, notifyMentions: true, notifyWaiting: false, showPreview: false };
    expect(wantsAlert("ASSIGNED", prefs)).toBe(true);
    expect(wantsAlert("CUSTOMER", prefs)).toBe(false);
    expect(wantsAlert("MENTION", prefs)).toBe(true);
    expect(wantsAlert("WAITING", prefs)).toBe(false);
  });

  it("turns several waiting conversations into one count, and one conversation stays itself", () => {
    expect(collapseWaiting([])).toBeNull();
    expect(collapseWaiting([alert(), alert()])?.title).toBe("Rahim");
    const many = collapseWaiting([alert(), alert({ conversationKey: "c2" }), alert({ conversationKey: "c3" })]);
    expect(many?.title).toBe("3 customers are waiting");
    expect(many?.preview).toBeNull();
    expect(many?.url).toBe("/p/x/conversations/all");
  });

  it("names a device in plain words", () => {
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile/15E Safari/604")).toBe("Safari on iPhone");
    expect(deviceLabel(null)).toBe("Browser on this device");
  });
});
