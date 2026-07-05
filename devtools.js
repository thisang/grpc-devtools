/**
 * DevTools panel registration
 * Creates a new tab "gRPC" in Chrome DevTools
 */
chrome.devtools.panels.create(
  'gRPC',
  'icons/icon16.png',
  'panel.html',
  function (panel) {
    console.log('[gRPC DevTools] Panel created');
  }
);
