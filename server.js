import app from "./src/app.js";
import { log } from "./src/utils/logger.js";

const port = process.env.PORT || 3000;

app.listen(port, () => {
  log(`Server running on port ${port}`);
});
