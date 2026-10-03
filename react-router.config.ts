import type { Config } from "@react-router/dev/config";

export default {
  // Render terminates HTTPS before forwarding requests to the app server.
  // Permit action posts from this app's own browser origin when the server-side
  // request URL is reconstructed as HTTP behind that trusted proxy.
  allowedActionOrigins: ["easymail-label.onrender.com"],
} satisfies Config;
