// Must be first: ES module imports are evaluated before any module body runs,
// so anything reading process.env at import time (executor URL and secret,
// model, timeouts) would otherwise see an unloaded .env.
import "dotenv/config";

import app from "./src/app.js";
import { warmUpProviders } from "./src/services/llmService.js";
import { log } from "./src/utils/logger.js";

const port = process.env.PORT || 3000;

app.listen(port, () => {
  log(`Server running on port ${port}`);

  // Not awaited: loading the local model can take a while, and the server
  // should answer turns in the meantime.
  warmUpProviders();
});
