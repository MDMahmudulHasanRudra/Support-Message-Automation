import type { ChannelType } from "@support-automation/shared";

/**
 * What an admin does OUTSIDE this app to connect each channel, step by step, in the provider's own
 * words for its screens. Kept beside the form that needs the results, so nobody has to find a wiki.
 */
export function SetupGuide({ type }: { type: ChannelType }) {
  if (type === "WEBCHAT") {
    return (
      <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        <li>Name the widget and list your website (a domain like example.com is enough).</li>
        <li>Design it in the Widget Builder: colours, logo, button, team photos, greeting — with a live preview on computer and phone.</li>
        <li>Copy the one-line install code (or download the WordPress plugin) and add it to your site. Step-by-step guides for WordPress, Shopify, React, Next.js, Webflow and Wix are on the widget page.</li>
        <li>Press “Verify installation” to confirm the widget started on your site.</li>
        <li>Optional: switch AI answers on, and let signed-in customers chat as themselves.</li>
      </ol>
    );
  }
  if (type === "TELEGRAM") {
    return (
      <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        <li>
          In Telegram, open <strong>@BotFather</strong> and send <code>/newbot</code> (or <code>/mybots</code> to pick an existing bot).
        </li>
        <li>Copy the bot&apos;s API token and paste it below. This app registers its own webhook with Telegram — nothing else to configure.</li>
        <li>
          For a bot that should read every message in a group, send BotFather <code>/setprivacy</code> → Disable. In private chats it sees everything anyway.
        </li>
        <li>A bot can have only one webhook: connecting it here replaces any webhook another service set for the same bot.</li>
        <li>Telegram delivers only to an https:// address, so this server must be reachable over HTTPS.</li>
      </ol>
    );
  }
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
      <li>
        In <strong>Meta for Developers</strong>, create a <strong>Business</strong> app (or use your existing one) and add the{" "}
        <strong>{type === "INSTAGRAM" ? "Instagram (Messenger API for Instagram)" : "Messenger"}</strong> product.
      </li>
      {type === "INSTAGRAM" ? (
        <li>
          The Instagram account must be a <strong>professional</strong> (Business or Creator) account linked to a Facebook Page, with <em>Allow access to messages</em> on (Instagram app →
          Settings → Messages and story replies → Message controls → Connected tools).
        </li>
      ) : null}
      <li>
        Copy the <strong>App ID</strong> and <strong>App Secret</strong> (App settings → Basic).
      </li>
      <li>
        Generate a <strong>Page access token</strong> for the Page (Messenger → Messenger API Settings → Access tokens, or a system user&apos;s token in Business Settings — those do not expire).
        The app needs <code>pages_messaging</code>
        {type === "INSTAGRAM" ? (
          <>
            , <code>instagram_basic</code> and <code>instagram_manage_messages</code>
          </>
        ) : null}
        ; serving Pages you do not own requires Meta&apos;s App Review.
      </li>
      <li>Paste the three values below. This app checks them with Meta and subscribes the Page to the app.</li>
      <li>
        Then, in the app&apos;s <strong>Webhooks</strong> settings for {type === "INSTAGRAM" ? "Instagram" : "the Page"}, paste the <strong>Callback URL</strong> and <strong>Verify token</strong>{" "}
        this app shows you, and subscribe to <code>messages</code>
        {type === "MESSENGER" ? (
          <>
            , <code>message_echoes</code>, <code>message_deliveries</code> and <code>message_reads</code>
          </>
        ) : (
          <>
            {" "}
            (and <code>messaging_seen</code> for read receipts)
          </>
        )}
        . One Meta app has one callback URL; if several Pages share an app, any of their connections&apos; URLs works for all of them.
      </li>
    </ol>
  );
}
