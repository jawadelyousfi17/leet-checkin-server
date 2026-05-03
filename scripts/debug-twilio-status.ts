import "dotenv/config";
import twilio from "twilio";

async function main() {
  const sid = process.argv[2];
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  if (sid) {
    const msg = await client.messages(sid).fetch();
    console.log("status:", msg.status);
    console.log("errorCode:", msg.errorCode);
    console.log("errorMessage:", msg.errorMessage);
    console.log("from:", msg.from, "to:", msg.to);
    console.log("dateSent:", msg.dateSent);
    console.log("messagingServiceSid:", msg.messagingServiceSid);
  } else {
    console.log("=== last 10 messages on this account ===");
    const list = await client.messages.list({ limit: 10 });
    for (const m of list) {
      console.log(`${m.dateCreated.toISOString()}  ${m.sid}  status=${m.status}  err=${m.errorCode ?? "-"} ${m.errorMessage ?? ""}  to=${m.to}  from=${m.from || m.messagingServiceSid}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
