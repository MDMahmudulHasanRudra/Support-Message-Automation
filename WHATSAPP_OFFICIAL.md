# WhatsApp (Official API)

Feature `WHATSAPP_OFFICIAL`, **off by default**, and it needs `OMNICHANNEL`. It is Meta's WhatsApp Cloud API as one more channel in All Conversations.
The QR-linked WhatsApp module is separate and unchanged: nothing here reads or writes `Message`, `WhatsAppAccount` or `OutboundMessage`.

**Not verified against real Meta.** It follows Meta's published webhook and send formats and is tested against simulated payloads. Before a business relies
on it: connect a Meta test number, have a phone write to it, reply from the inbox, wait for a template to be approved and send one.

## What a business needs

- A Meta app with the WhatsApp product, and business verification to go beyond test numbers.
- A number given to the Cloud API. Such a number stops working in the normal WhatsApp app, so it cannot also be a QR-linked number.
- A System User token with `whatsapp_business_messaging` and `whatsapp_business_management`.

Each number is connected by hand at Settings → Messaging Channels: phone number ID, business account ID, App ID, app secret, token. Meta's Embedded Signup
is not built. Then copy the callback address and verify token into WhatsApp → Configuration and subscribe to the `messages` field.

## How it works

- Webhooks use the existing `/api/channels/meta/<key>` address, signature check and `ChannelInboundEvent`. An event goes to the connection, in the key's project
  and on the same app, whose phone number id it names. A number nobody connected is dropped.
- Replies are ordinary `ChannelMessage` rows on the channels' one send queue. AI, routing, contacts, menu bots and the inbox work as on any other channel.
- Templates are written and approved in WhatsApp Manager. Sync templates copies the list into `WhatsAppCloudTemplate`.

## Rules worth not undoing

- **24 hours.** A free reply needs the customer's last message within 24 hours (`decideReplyWindow`), checked when queued and again at send time.
- **A template bypasses the window only for a person.** `outboundProcessor` allows it only with `templateName` and not automated. AI and bots never use one.
- **A template is one press to one person who has written in.** `queueCloudTemplate` refuses a conversation with no inbound message and anything not APPROVED. Meta
  charges for each, so there is no bulk path; do not add one without a decision about cost and spam.
- **Only plain-text bodies with numbered blanks are offered.** A media header, named blanks or a link with a blank is listed as not sendable.
- **The switch stops both directions**, in the worker, and keeps every conversation.
- **The token and app secret are encrypted** and decrypted only by the channel code that sends with them.
- **An unknowable send outcome is UNKNOWN**, never retried by itself, as on every channel. A failure Meta reports later (`status: failed`) marks the message FAILED with the reason.
