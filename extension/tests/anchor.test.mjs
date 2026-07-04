// Tests for anchorFromFind: deriving a rendered-text anchor from an edit's
// markdown find string, for the in-page highlight when the user didn't select.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { anchorFromFind } = await import(await bundle("src/adapters/proposal-engine.ts"));

test("prose: returns the sentence itself", () => {
  assert.equal(anchorFromFind("The delivery drivers follow the route."), "The delivery drivers follow the route.");
});

test("table row: returns the longest single cell (contiguous rendered text)", () => {
  // Cells are pipe-delimited; the longest run is one cell, which appears
  // verbatim inside one rendered <td> (cross-cell text is not contiguous).
  const found = "| Dispatchers | Assign runs and watch progress in real time | Use the web console |";
  assert.equal(anchorFromFind(found), "Assign runs and watch progress in real time");
});

test("strips heading/emphasis/list syntax", () => {
  assert.equal(anchorFromFind("## Out of scope"), "Out of scope");
  assert.equal(anchorFromFind("- Fleet maintenance and telematics"), "Fleet maintenance and telematics");
});

test("link: keeps the link text, drops the URL", () => {
  assert.equal(
    anchorFromFind("See [the scope section](/product-context/#scope) here"),
    "See the scope section here",
  );
});

test("nothing distinctive (all short tokens) -> undefined", () => {
  assert.equal(anchorFromFind("| a | b | c |"), undefined);
});
