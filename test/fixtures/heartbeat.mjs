import { appendFileSync, writeFileSync } from "node:fs";
const marker = process.argv[2];
writeFileSync(marker, "start");
setInterval(() => appendFileSync(marker, "."), 20);
