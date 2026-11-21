import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalWord, stripLeadingMentions } from "../src/parser.js";

test("approval words: Portuguese and English answers, anything else is not an answer", () => {
  for (const text of ["aprovo", "Sim", "approve", "yes, run it"]) assert.equal(approvalWord(text), "approve");
  for (const text of ["rejeito", "não", "nao", "reject", "cancel"]) assert.equal(approvalWord(text), "reject");
  for (const text of ["", "simples", "help", "run: ls"]) assert.equal(approvalWord(text), null);
});

test("leading mentions: longest known name wins, case-insensitive, unknown mentions stay", () => {
  const names = ["Coder", "Coder Two", "Plain"];
  assert.deepEqual(stripLeadingMentions("@coder two  aprovo", names), { text: "aprovo", mentioned: ["Coder Two"] });
  assert.deepEqual(stripLeadingMentions("@Coder, @Plain: sim", names), { text: "sim", mentioned: ["Coder", "Plain"] });
  assert.deepEqual(stripLeadingMentions("@Coderx aprovo", names), { text: "@Coderx aprovo", mentioned: [] });
  assert.deepEqual(stripLeadingMentions("aprovo @Coder", names), { text: "aprovo @Coder", mentioned: [] });
});
