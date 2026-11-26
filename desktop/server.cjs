"use strict";

// Trigger Next's own shutdown handler on either platform. Windows would
// terminate the process immediately if the desktop sent a real SIGTERM.
process.on("disconnect", () => {
  if (!process.emit("SIGTERM", "SIGTERM")) process.exit(0);
  setTimeout(() => process.exit(0), 3_000).unref();
});

const nextCli = require.resolve("next/dist/bin/next", { paths: [process.cwd()] });
process.argv[1] = nextCli;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Start the packaged Next.js CLI in this process.
require(nextCli);
