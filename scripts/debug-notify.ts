import "dotenv/config";
import twilio from "twilio";
import { Resend } from "resend";

async function main() {
  console.log("=== env ===");
  console.log("TWILIO_ACCOUNT_SID:", mask(process.env.TWILIO_ACCOUNT_SID));
  console.log("TWILIO_AUTH_TOKEN:", mask(process.env.TWILIO_AUTH_TOKEN));
  console.log("TWILIO_MESSAGING_SERVICE_SID:", process.env.TWILIO_MESSAGING_SERVICE_SID || "(unset)");
  console.log("TWILIO_FROM:", process.env.TWILIO_FROM || "(unset)");
  console.log("NOTIFY_PHONE:", process.env.NOTIFY_PHONE || "(unset)");
  console.log("RESEND_API_KEY:", mask(process.env.RESEND_API_KEY));
  console.log("RESEND_FROM:", process.env.RESEND_FROM || "(unset)");
  console.log("NOTIFY_EMAIL:", process.env.NOTIFY_EMAIL || "(unset)");
  console.log();

  console.log("=== Twilio SMS test ===");
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.NOTIFY_PHONE) {
    console.log("missing core Twilio env, skipping");
  } else {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const sender = process.env.TWILIO_MESSAGING_SERVICE_SID
      ? { messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID }
      : process.env.TWILIO_FROM
        ? { from: process.env.TWILIO_FROM }
        : null;
    if (!sender) {
      console.log("no sender configured");
    } else {
      try {
        const msg = await client.messages.create({
          ...sender,
          to: process.env.NOTIFY_PHONE,
          body: "[leet-checkin] debug-notify test message",
        });
        console.log("queued sid:", msg.sid, "status:", msg.status, "to:", msg.to);
      } catch (err: unknown) {
        console.error("Twilio error:");
        console.error(err);
      }
    }
  }
  console.log();

  console.log("=== Resend email test ===");
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM || !process.env.NOTIFY_EMAIL) {
    console.log("missing Resend env, skipping");
  } else {
    const resend = new Resend(process.env.RESEND_API_KEY);
    try {
      const r = await resend.emails.send({
        from: process.env.RESEND_FROM,
        to: process.env.NOTIFY_EMAIL,
        subject: "[leet-checkin] debug-notify test",
        text: "test message body",
      });
      console.log("resend response:", r);
    } catch (err) {
      console.error("Resend error:");
      console.error(err);
    }
  }
}

function mask(v: string | undefined): string {
  if (!v) return "(unset)";
  if (v.length <= 8) return "***";
  return v.slice(0, 4) + "…" + v.slice(-4);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
