// A minimal third-party plugin: plain JavaScript, no build step, default export.
export default {
  name: "example-plugin",
  detectors: [
    {
      id: "always-one",
      title: "Always one",
      description: "Example detector that reports one finding per session.",
      run({ store }) {
        return store.db
          .prepare("SELECT id FROM sessions")
          .all()
          .map((s) => ({
            detector: "always-one",
            severity: "info",
            sessionId: s.id,
            turnIds: [],
            title: "Example finding",
            evidence: [],
            wastedTokens: 0,
            wastedUsd: 0,
          }));
      },
    },
  ],
};
