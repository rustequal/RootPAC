addEventListener("message", (event) => {
  if (event.source !== parent) return;
  let outcome;
  try {
    outcome = rootpacTrial(event.data);
  } catch (error) {
    const message = `Trial runner failed: ${error instanceof Error ? error.message : typeof error}`;
    outcome = { ok: false, stage: "init", kind: "throw", host: null, message, line: null, column: null };
  }
  parent.postMessage(outcome, "*");
});
