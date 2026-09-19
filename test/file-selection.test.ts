import test from "node:test";
import assert from "node:assert/strict";
import { linkableVaultFiles } from "../src/ui/file-selection";

test("existing-file association includes every format except the current mind tree", () => {
  const current = { path: "Maps/Current.mtn.md" };
  const files = [
    { path: "Notes/Topic.md" },
    { path: "Assets/Image.png" },
    { path: "Assets/Archive.zip" },
    { path: "Drawings/Sketch.excalidraw.md" },
    { path: "Maps/Other.mtn.md" },
    current
  ];

  assert.deepEqual(
    linkableVaultFiles(files, current.path).map((file) => file.path),
    [
      "Assets/Archive.zip",
      "Assets/Image.png",
      "Drawings/Sketch.excalidraw.md",
      "Maps/Other.mtn.md",
      "Notes/Topic.md"
    ]
  );
  assert.deepEqual(files.at(-1), current);
});
