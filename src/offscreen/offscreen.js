const TARGET = "rootpac-trial";

function trial(request) {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow) return;
      removeEventListener("message", onMessage);
      frame.remove();
      resolve(event.data);
    };
    addEventListener("message", onMessage);
    frame.addEventListener("load", () => frame.contentWindow.postMessage(request, "*"), { once: true });
    frame.src = "../sandbox/sandbox.html";
    document.body.append(frame);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== TARGET) return false;
  trial(message.request).then(sendResponse);
  return true;
});
