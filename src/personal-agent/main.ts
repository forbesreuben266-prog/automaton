/** Entry point: node dist/personal-agent/main.js <command> */

import { main } from "./cli.js";

if (process.argv[1]?.endsWith("/personal-agent/main.js")) {
  main(process.argv.slice(2), { out: (s) => process.stdout.write(s) }).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
