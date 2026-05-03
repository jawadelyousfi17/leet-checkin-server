import "dotenv/config";
import { getAllUsers } from "../src/services/usersClient";

async function main() {
  console.log("HOST_API:", process.env.HOST_API);
  console.log("ALL_USERS_API_TOKEN:", process.env.ALL_USERS_API_TOKEN ? "(set)" : "(unset)");
  console.log();

  const users = await getAllUsers();
  console.log(`fetched ${users.length} users`);
  for (const u of users) {
    console.log(`- ${u.id.slice(0, 8)} ${u.email ?? "—"} phone=${u.phoneNumber ?? "—"} sms=${u.smsEnabled} call=${u.callEnabled} email=${u.emailEnabled}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
