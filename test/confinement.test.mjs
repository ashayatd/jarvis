// The workspace confinement rule, as a table. This service is reachable
// through the tunnel and "type" reads files, so what this rejects is the
// difference between reading a project file and reading the Groq key.
import assert from "node:assert/strict";
import { test } from "node:test";

import { escapesWorkspace } from "../src/tools/registry.js";

// [command, must be rejected]
const cases = [
  // Ordinary work, all relative: none of this may be blocked.
  ["type notes.txt", false],
  ["type src/index.js", false],
  ["dir", false],
  ["dir /s", false],
  ["ls", false],
  ["whoami", false],
  ["date", false],
  ["node -v", false],
  ["npm -v", false],
  ["git status", false],
  ["git log --oneline", false],
  ["git diff --stat", false],

  // Running a project. A URL has a colon in it but no drive letter before it,
  // which is the case the absolute-path rule has to get right.
  ["npm start", false],
  ["npm run dev", false],
  ["node server.js", false],
  ["node src/index.js", false],
  ["python app.py", false],
  ["python -m http.server 8000", false],
  ["npx serve", false],
  ["start http://localhost:3000", false],
  ["start https://localhost:5173/", false],

  // Absolute drive paths, in both slash directions and either case.
  ["type C:\\Users\\me\\.env", true],
  ["type C:/Users/me/.env", true],
  ["type c:\\windows\\win.ini", true],
  ["dir C:\\", true],
  ["dir C:/", true],
  // Drive-relative, which resolves against that drive rather than the cwd.
  ["type C:secrets.txt", true],
  // Quoted, because quotes are not what makes a path relative.
  ['type "C:\\x\\y"', true],

  // Root-relative and UNC: absolute without naming a drive.
  ["type \\Windows\\win.ini", true],
  ["dir \\\\server\\share", true],

  // Traversal, including from the middle of a path.
  ["type ..\\..\\jarvis\\.env", true],
  ["type ../../jarvis/.env", true],
  ["type notes/../../secrets", true],
  ["dir ..", true],
];

test("the confinement rule matches the table", () => {
  const wrong = cases.filter(([command, expected]) => escapesWorkspace(command) !== expected);

  assert.deepEqual(
    wrong.map(([command, expected]) => `${command} should be ${expected ? "rejected" : "allowed"}`),
    [],
  );
});

test("a git revision range is a known casualty of the traversal rule", () => {
  // Documented rather than fixed: ".." anywhere is a rule with no gaps, and a
  // revision range is not something anyone asks for by voice. If this ever
  // matters, it is the line to revisit.
  assert.equal(escapesWorkspace("git log main..HEAD"), true);
});
