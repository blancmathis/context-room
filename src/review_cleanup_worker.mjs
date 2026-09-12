import { runAuthorizedReviewCleanup } from "./context_room.mjs";
try { process.stdout.write(JSON.stringify(runAuthorizedReviewCleanup(process.argv[2])) + "\n"); }
catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
