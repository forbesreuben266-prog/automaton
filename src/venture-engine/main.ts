/** Entry point: node dist/venture-engine/main.js <command> */

import { main } from "./cli.js";

if (process.argv[1]?.endsWith("/venture-engine/main.js")) {
  main(process.argv.slice(2), { out: (s) => process.stdout.write(s) }).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
