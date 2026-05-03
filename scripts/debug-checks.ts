import "dotenv/config";
import { prisma } from "../src/db";

async function main() {
  const monitors = await prisma.monitor.findMany({
    include: {
      keywords: true,
      checks: { orderBy: { checkedAt: "desc" }, take: 5 },
    },
  });
  for (const m of monitors) {
    console.log("---");
    console.log(`${m.name}  active=${m.isActive}  url=${m.url}  every=${m.intervalSec}s`);
    console.log(`keywords (${m.keywords.length}):`, m.keywords.map((k) => `${k.mode === "MISSING" ? "!" : ""}${k.value}`));
    if (m.checks.length === 0) {
      console.log("  no checks recorded");
    } else {
      for (const c of m.checks) {
        console.log(`  ${c.checkedAt.toISOString()}  ${c.status}  http=${c.httpStatus ?? "-"}  ${c.durationMs ?? "-"}ms  ${c.errorMessage ?? ""}`);
      }
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
