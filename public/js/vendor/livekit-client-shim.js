// @livekit/track-processors imports "livekit-client" as an ES module, but this app loads LiveKit
// as the UMD build (window.LivekitClient). The import map in index.html points that import here,
// so the processor shares the page's one LiveKit instead of loading a second copy.
// The processor only uses getLogger.
export const getLogger = (...args) => window.LivekitClient.getLogger(...args);
