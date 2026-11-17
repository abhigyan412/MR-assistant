import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  auth: false,
  // Voice-note audio (audit trail). Private: read through short-lived signed
  // URLs only. Branch-scoped, so demo/test branches have their own files.
  // Retention is enforced by the app (AUDIO_RETENTION_DAYS), see lib/audio.ts.
  buckets: {
    "voice-notes": {},
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
